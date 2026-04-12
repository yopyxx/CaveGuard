// index.js
// npm i discord.js
// Node.js 18+

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  EmbedBuilder,
  Collection,
} = require("discord.js");

/* =========================
   환경변수
========================= */
const RAW_TOKEN = process.env.TOKEN || "";
const TOKEN = RAW_TOKEN.replace(/^Bot\s+/i, "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();
const LOG_CHANNEL_ID = (process.env.LOG_CHANNEL_ID || "").trim();
const QUARANTINE_ROLE_ID = (process.env.QUARANTINE_ROLE_ID || "").trim();

/* =========================
   보호/예외 설정
========================= */
const SUPER_ADMIN_IDS = new Set([
  // "123456789012345678",
]);

const PROTECTED_ROLE_IDS = new Set([
  // "123456789012345678",
]);

const SAFE_INVITE_CHANNEL_IDS = new Set([
  // "123456789012345678",
]);

const SAFE_INVITE_ROLE_IDS = new Set([
  // "123456789012345678",
]);

/* =========================
   설정값
========================= */
const SPAM_WINDOW_MS = 15 * 1000;
const SPAM_LINK_THRESHOLD = 3;

const TIMEOUT_MS_SPAM = 7 * 24 * 60 * 60 * 1000; // 1주
const TIMEOUT_MS_NUKE = 7 * 24 * 60 * 60 * 1000; // 1주

const NUKE_WINDOW_MS = 30 * 1000;
const NUKE_ROLE_DELETE_THRESHOLD = 1;

const AUTO_BACKUP_INTERVAL_MINUTES = 5;
const ROLE_WATCH_INTERVAL_SECONDS = 10; // 역할 삭제 감지용 주기 스캔
const RISK_LOG_KEEP_DAYS = 60;
const RECENT_CHANNEL_SCAN_LIMIT = 8;

/* =========================
   데이터 파일
========================= */
const DATA_DIR = path.join(__dirname, "data");
const ROLE_BACKUP_FILE = path.join(DATA_DIR, "role_backup.json");
const RISK_LOG_FILE = path.join(DATA_DIR, "risk_log.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* =========================
   유틸
========================= */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`JSON 읽기 실패: ${file}`, err);
    return fallback;
  }
}

function atomicWriteJson(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  if (!text) return "";
  return String(text)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDiscordInviteLike(content) {
  if (!content) return false;
  const text = normalizeText(content).toLowerCase().replace(/\s+/g, "");

  return (
    /discord\.gg\/[a-z0-9-]+/i.test(text) ||
    /discord\.com\/invite\/[a-z0-9-]+/i.test(text) ||
    /discordapp\.com\/invite\/[a-z0-9-]+/i.test(text) ||
    /d1scord|disc0rd|dlscord|d1sc0rd|discord-gift|steamcommunity\.gift|nitro/i.test(text)
  );
}

function hasAdministrator(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

function memberHasAnyRole(member, roleIds) {
  if (!member) return false;
  return [...roleIds].some((id) => member.roles.cache.has(id));
}

function isProtectedUser(member) {
  if (!member) return false;
  if (SUPER_ADMIN_IDS.has(member.id)) return true;
  if (member.guild.ownerId === member.id) return true;
  if (memberHasAnyRole(member, PROTECTED_ROLE_IDS)) return true;
  if (hasAdministrator(member)) return true;
  return false;
}

function truncate(str, max = 1024) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

function roleToSnapshot(role, membersWithRole = []) {
  return {
    oldRoleId: role.id,
    name: role.name,
    color: role.color,
    permissions: role.permissions.bitfield.toString(),
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    managed: role.managed,
    icon: role.icon || null,
    unicodeEmoji: role.unicodeEmoji || null,
    memberIds: membersWithRole,
    restoredRoleId: null,
    deletedAt: null,
    restoredAt: null,
    isDeleted: false,
    restoreFailures: [],
    lastSyncedAt: nowISO(),
  };
}

function memberHasRoleWithPermission(member, permissionFlag) {
  if (!member) return false;

  return member.roles.cache.some((role) => {
    if (role.id === member.guild.id) return false;
    return role.permissions.has(permissionFlag);
  });
}

function memberHasManageRolesRole(member) {
  return memberHasRoleWithPermission(member, PermissionFlagsBits.ManageRoles);
}

function hasHighRiskPermsNow(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ManageRoles) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions.has(PermissionFlagsBits.BanMembers) ||
    member.permissions.has(PermissionFlagsBits.KickMembers) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers)
  );
}

async function sendLog(guild, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("로그 전송 실패:", err);
  }
}

/* =========================
   데이터 접근
========================= */
function getRoleBackupData() {
  return readJson(ROLE_BACKUP_FILE, {
    guildId: null,
    savedAt: null,
    roles: {},
  });
}

function setRoleBackupData(data) {
  atomicWriteJson(ROLE_BACKUP_FILE, data);
}

function getRiskLogData() {
  return readJson(RISK_LOG_FILE, {
    nukeCases: [],
    spamCases: [],
    nukeTracker: {},
  });
}

function setRiskLogData(data) {
  atomicWriteJson(RISK_LOG_FILE, data);
}

function pruneRiskLogData() {
  const risk = getRiskLogData();
  const cutoff = Date.now() - RISK_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;

  risk.nukeCases = (risk.nukeCases || []).filter((x) => {
    const t = new Date(x.processedAt || x.detectedAt || 0).getTime();
    return t >= cutoff;
  });

  risk.spamCases = (risk.spamCases || []).filter((x) => {
    const t = new Date(x.detectedAt || 0).getTime();
    return t >= cutoff;
  });

  const tracker = risk.nukeTracker || {};
  for (const userId of Object.keys(tracker)) {
    tracker[userId] = (tracker[userId] || []).filter((ts) => Date.now() - ts <= NUKE_WINDOW_MS);
    if (!tracker[userId].length) delete tracker[userId];
  }

  risk.nukeTracker = tracker;
  setRiskLogData(risk);
}

/* =========================
   클라이언트
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const spamTracker = new Collection();
const recentUserChannels = new Collection();
const roleStateCache = new Map(); // guildId -> Map(roleId, snapshot)

/* =========================
   슬래시 명령어
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("삭제된역할")
    .setDescription("삭제된 역할 목록을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("역할복구")
    .setDescription("삭제된 역할 중 특정 역할만 복구합니다. 이름 또는 목록 번호를 입력할 수 있습니다.")
    .addStringOption((opt) =>
      opt
        .setName("식별자")
        .setDescription("복구할 역할 이름 또는 삭제된역할 목록 번호")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("역할전체복구")
    .setDescription("삭제된 역할을 전부 복구합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("역할지급")
    .setDescription("복구된 역할을 원래 보유 인원에게 다시 지급합니다.")
    .addStringOption((opt) =>
      opt
        .setName("역할이름")
        .setDescription("특정 역할만 다시 지급하고 싶을 때 입력")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("위험기록")
    .setDescription("스팸/누크 자동 조치 기록을 확인합니다.")
    .addStringOption((opt) =>
      opt
        .setName("유형")
        .setDescription("확인할 유형")
        .setRequired(false)
        .addChoices(
          { name: "전체", value: "all" },
          { name: "누크", value: "nuke" },
          { name: "스팸", value: "spam" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("테러위험대상")
    .setDescription("자동 격리 및 권한 박탈된 대상 목록을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("위험해제")
    .setDescription("격리 및 박탈된 권한을 해제합니다.")
    .addUserOption((opt) =>
      opt
        .setName("대상")
        .setDescription("해제할 대상 유저")
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("역할복원")
        .setDescription("박탈된 관리 역할도 함께 복원할지 여부")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: [] }
  );

  await sleep(1000);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log(`슬래시 명령어 등록 완료: ${commands.length}개`);
}

/* =========================
   역할 백업/동기화
========================= */
async function backupAllRoles(guild) {
  await guild.roles.fetch().catch(() => null);
  await guild.members.fetch();

  const previous = getRoleBackupData();

  const data = {
    guildId: guild.id,
    savedAt: nowISO(),
    roles: {},
  };

  // 기존 삭제 기록 보존
  for (const [roleId, snapshot] of Object.entries(previous.roles || {})) {
    if (snapshot?.isDeleted === true) {
      data.roles[roleId] = snapshot;
    }
  }

  // 현재 존재하는 역할 최신화
  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position);

  for (const role of roles.values()) {
    if (role.managed) continue;

    const memberIds = guild.members.cache
      .filter((member) => member.roles.cache.has(role.id))
      .map((member) => member.id);

    const old = previous.roles?.[role.id] || {};

    data.roles[role.id] = {
      oldRoleId: role.id,
      name: role.name,
      color: role.color,
      permissions: role.permissions.bitfield.toString(),
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      managed: role.managed,
      icon: role.icon || null,
      unicodeEmoji: role.unicodeEmoji || null,
      memberIds,
      restoredRoleId: old.restoredRoleId || null,
      deletedAt: null,
      restoredAt: old.restoredAt || null,
      isDeleted: false,
      restoreFailures: old.restoreFailures || [],
      lastSyncedAt: nowISO(),
    };
  }

  setRoleBackupData(data);
  rebuildRoleStateCacheForGuild(guild, data);
  return Object.keys(data.roles).length;
}

function ensureBackupRoot(guildId) {
  const backup = getRoleBackupData();
  if (!backup.guildId) backup.guildId = guildId;
  if (!backup.roles) backup.roles = {};
  return backup;
}

async function syncSingleRoleSnapshot(guild, role) {
  if (!guild || !role) return;
  if (role.id === guild.id) return;
  if (role.managed) return;

  const backup = ensureBackupRoot(guild.id);
  await guild.members.fetch().catch(() => null);

  const memberIds = guild.members.cache
    .filter((member) => member.roles.cache.has(role.id))
    .map((member) => member.id);

  const old = backup.roles[role.id] || {};

  backup.roles[role.id] = {
    oldRoleId: role.id,
    name: role.name,
    color: role.color,
    permissions: role.permissions.bitfield.toString(),
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    managed: role.managed,
    icon: role.icon || null,
    unicodeEmoji: role.unicodeEmoji || null,
    memberIds,
    restoredRoleId: old.restoredRoleId || null,
    deletedAt: null,
    restoredAt: old.restoredAt || null,
    isDeleted: false,
    restoreFailures: old.restoreFailures || [],
    lastSyncedAt: nowISO(),
  };

  backup.savedAt = nowISO();
  setRoleBackupData(backup);

  const guildMap = roleStateCache.get(guild.id) || new Map();
  guildMap.set(role.id, JSON.parse(JSON.stringify(backup.roles[role.id])));
  roleStateCache.set(guild.id, guildMap);
}

function markRoleDeletedOrCreateSnapshot(guild, role, reasonText = null) {
  const backup = ensureBackupRoot(guild.id);
  const old = backup.roles[role.id];

  if (old) {
    old.name = role.name;
    old.color = role.color;
    old.permissions = role.permissions.bitfield.toString();
    old.hoist = role.hoist;
    old.mentionable = role.mentionable;
    old.position = role.position;
    old.managed = role.managed;
    old.icon = role.icon || null;
    old.unicodeEmoji = role.unicodeEmoji || null;
    old.isDeleted = true;
    old.deletedAt = nowISO();
    old.restoredRoleId = null;
    old.restoredAt = null;
    old.lastSyncedAt = nowISO();
    if (!Array.isArray(old.restoreFailures)) old.restoreFailures = [];
    if (reasonText && !old.restoreFailures.includes(reasonText)) {
      old.restoreFailures.unshift(reasonText);
    }
  } else {
    backup.roles[role.id] = {
      oldRoleId: role.id,
      name: role.name,
      color: role.color,
      permissions: role.permissions.bitfield.toString(),
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      managed: role.managed,
      icon: role.icon || null,
      unicodeEmoji: role.unicodeEmoji || null,
      memberIds: [],
      restoredRoleId: null,
      deletedAt: nowISO(),
      restoredAt: null,
      isDeleted: true,
      restoreFailures: [
        reasonText || "삭제 전 백업 데이터가 없어 역할 보유자 목록을 복구하지 못했습니다.",
      ],
      lastSyncedAt: nowISO(),
    };
  }

  backup.savedAt = nowISO();
  setRoleBackupData(backup);

  const guildMap = roleStateCache.get(guild.id) || new Map();
  guildMap.delete(role.id);
  roleStateCache.set(guild.id, guildMap);
}

async function syncMemberRolesToSnapshots(member) {
  if (!member?.guild) return;

  const guild = member.guild;
  const backup = ensureBackupRoot(guild.id);
  let changed = false;

  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id) continue;
    if (role.managed) continue;

    if (!backup.roles[role.id]) {
      backup.roles[role.id] = roleToSnapshot(role, []);
      changed = true;
    }

    const snap = backup.roles[role.id];
    if (!Array.isArray(snap.memberIds)) snap.memberIds = [];

    const hasRole = member.roles.cache.has(role.id);
    const exists = snap.memberIds.includes(member.id);

    if (hasRole && !exists) {
      snap.memberIds.push(member.id);
      snap.lastSyncedAt = nowISO();
      changed = true;
    } else if (!hasRole && exists) {
      snap.memberIds = snap.memberIds.filter((id) => id !== member.id);
      snap.lastSyncedAt = nowISO();
      changed = true;
    }
  }

  if (changed) {
    backup.savedAt = nowISO();
    setRoleBackupData(backup);
  }
}

function rebuildRoleStateCacheForGuild(guild, backup = null) {
  const source = backup || getRoleBackupData();
  const guildMap = new Map();

  for (const [roleId, snap] of Object.entries(source.roles || {})) {
    if (snap?.isDeleted) continue;
    guildMap.set(roleId, JSON.parse(JSON.stringify(snap)));
  }

  roleStateCache.set(guild.id, guildMap);
}

async function detectDeletedRolesByScan(guild) {
  await guild.roles.fetch().catch(() => null);

  const currentRoleIds = new Set(
    guild.roles.cache
      .filter((role) => role.id !== guild.id && !role.managed)
      .map((role) => role.id)
  );

  const cached = roleStateCache.get(guild.id) || new Map();
  const deleted = [];

  for (const [roleId, oldSnapshot] of cached.entries()) {
    if (!currentRoleIds.has(roleId)) {
      deleted.push(oldSnapshot);
    }
  }

  if (!deleted.length) return 0;

  for (const oldSnapshot of deleted) {
    markRoleDeletedOrCreateSnapshot(
      guild,
      {
        id: oldSnapshot.oldRoleId,
        name: oldSnapshot.name,
        color: oldSnapshot.color,
        permissions: { bitfield: BigInt(oldSnapshot.permissions) },
        hoist: oldSnapshot.hoist,
        mentionable: oldSnapshot.mentionable,
        position: oldSnapshot.position,
        managed: oldSnapshot.managed,
        icon: oldSnapshot.icon || null,
        unicodeEmoji: oldSnapshot.unicodeEmoji || null,
      },
      "주기 스캔으로 삭제된 역할을 감지했습니다."
    );

    console.log(`[역할스캔감지] 삭제된 역할 기록 반영: ${oldSnapshot.name} (${oldSnapshot.oldRoleId})`);
  }

  const updatedMap = roleStateCache.get(guild.id) || new Map();
  for (const oldSnapshot of deleted) {
    updatedMap.delete(oldSnapshot.oldRoleId);
  }
  roleStateCache.set(guild.id, updatedMap);

  return deleted.length;
}

/* =========================
   삭제 기록 조회
========================= */
function getDeletedRoleSnapshots(guildId) {
  const backup = getRoleBackupData();
  if (!backup.guildId || backup.guildId !== guildId) return [];
  return Object.values(backup.roles || {})
    .filter((r) => r.isDeleted === true)
    .sort((a, b) => {
      const aTime = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
      const bTime = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
      return bTime - aTime;
    });
}

function resolveDeletedRoleSnapshot(guildId, identifier) {
  const deleted = getDeletedRoleSnapshots(guildId);
  if (!deleted.length) return null;

  const raw = String(identifier || "").trim();
  const asNum = Number(raw);

  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= deleted.length) {
    return deleted[asNum - 1];
  }

  return deleted.find((r) => r.name === raw) || null;
}

/* =========================
   공통 역할 생성
========================= */
async function createRoleFromSnapshot(guild, snapshot, reasonPrefix) {
  const failures = [];

  const createPayload = {
    name: snapshot.name,
    color: snapshot.color,
    permissions: BigInt(snapshot.permissions),
    hoist: snapshot.hoist,
    mentionable: snapshot.mentionable,
    reason: `${reasonPrefix}: ${snapshot.name}`,
  };

  if (snapshot.icon) createPayload.icon = snapshot.icon;
  if (snapshot.unicodeEmoji) createPayload.unicodeEmoji = snapshot.unicodeEmoji;

  let newRole;
  try {
    newRole = await guild.roles.create(createPayload);
  } catch (err) {
    throw new Error(`역할 생성 실패: ${err.message}`);
  }

  await sleep(700);

  try {
    await newRole.setPosition(snapshot.position, {
      reason: `${reasonPrefix} 위치 복원: ${snapshot.name}`,
    });
  } catch (err) {
    failures.push(`위치 복원 실패: ${err.message}`);
  }

  return { newRole, failures };
}

/* =========================
   역할 복구
========================= */
async function restoreSingleDeletedRole(guild, identifier) {
  const backup = getRoleBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 역할 백업 데이터가 없습니다.");
  }

  const snapshot = resolveDeletedRoleSnapshot(guild.id, identifier);
  if (!snapshot) {
    return { ok: false, reason: "삭제된 기록이 있는 해당 역할을 찾지 못했습니다." };
  }

  const existingRole = guild.roles.cache.find((r) => r.name === snapshot.name);
  if (existingRole) {
    return {
      ok: false,
      reason: `이미 서버에 "${snapshot.name}" 역할이 존재하여 중복 생성하지 않았습니다.`,
    };
  }

  await guild.members.fetch();

  const { newRole, failures } = await createRoleFromSnapshot(guild, snapshot, "정밀 역할 복구");

  snapshot.restoredRoleId = newRole.id;
  snapshot.restoredAt = nowISO();
  snapshot.isDeleted = false;
  snapshot.restoreFailures = [];

  let assignedCount = 0;
  const assignFailures = [];

  for (const memberId of snapshot.memberIds || []) {
    const member = guild.members.cache.get(memberId);
    if (!member) {
      assignFailures.push(`멤버 없음: ${memberId}`);
      continue;
    }

    try {
      if (!member.roles.cache.has(newRole.id)) {
        await member.roles.add(newRole, `정밀 역할 복구 자동 재지급: ${snapshot.name}`);
        assignedCount++;
        await sleep(250);
      }
    } catch (err) {
      assignFailures.push(`${member.user.tag}: ${err.message}`);
    }
  }

  snapshot.restoreFailures = [...failures, ...assignFailures];
  setRoleBackupData(backup);

  const guildMap = roleStateCache.get(guild.id) || new Map();
  guildMap.set(newRole.id, JSON.parse(JSON.stringify(snapshot)));
  roleStateCache.set(guild.id, guildMap);

  return {
    ok: true,
    roleName: snapshot.name,
    roleId: newRole.id,
    assignedCount,
    failures: snapshot.restoreFailures,
  };
}

async function restoreAllDeletedRoles(guild) {
  const backup = getRoleBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 역할 백업 데이터가 없습니다.");
  }

  await guild.members.fetch();

  const deletedSnapshots = Object.values(backup.roles || {})
    .filter((r) => r.isDeleted === true)
    .sort((a, b) => a.position - b.position);

  const restored = [];
  const skipped = [];

  for (const snapshot of deletedSnapshots) {
    const existingRole = guild.roles.cache.find((r) => r.name === snapshot.name);
    if (existingRole) {
      skipped.push({ name: snapshot.name, reason: "이미 같은 이름의 역할이 서버에 존재함" });
      continue;
    }

    try {
      const { newRole, failures } = await createRoleFromSnapshot(guild, snapshot, "역할전체복구");

      snapshot.restoredRoleId = newRole.id;
      snapshot.restoredAt = nowISO();
      snapshot.isDeleted = false;
      snapshot.restoreFailures = [];

      let assignedCount = 0;
      const assignFailures = [];

      for (const memberId of snapshot.memberIds || []) {
        const member = guild.members.cache.get(memberId);
        if (!member) {
          assignFailures.push(`멤버 없음: ${memberId}`);
          continue;
        }

        try {
          if (!member.roles.cache.has(newRole.id)) {
            await member.roles.add(newRole, `역할전체복구 자동 재지급: ${snapshot.name}`);
            assignedCount++;
            await sleep(250);
          }
        } catch (err) {
          assignFailures.push(`${member.user.tag}: ${err.message}`);
        }
      }

      snapshot.restoreFailures = [...failures, ...assignFailures];
      restored.push({
        name: snapshot.name,
        assignedCount,
        failureCount: snapshot.restoreFailures.length,
      });

      const guildMap = roleStateCache.get(guild.id) || new Map();
      guildMap.set(newRole.id, JSON.parse(JSON.stringify(snapshot)));
      roleStateCache.set(guild.id, guildMap);
    } catch (err) {
      console.error(`역할 복구 실패: ${snapshot.name}`, err);
      skipped.push({ name: snapshot.name, reason: err.message || "복구 중 오류 발생" });
    }
  }

  setRoleBackupData(backup);
  return { restored, skipped };
}

async function reassignRestoredRoles(guild, roleName = null) {
  const backup = getRoleBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 역할 백업 데이터가 없습니다.");
  }

  await guild.members.fetch();

  let successCount = 0;
  const failures = [];

  for (const snapshot of Object.values(backup.roles || {})) {
    if (!snapshot.restoredRoleId) continue;
    if (roleName && snapshot.name !== roleName) continue;

    const restoredRole =
      guild.roles.cache.get(snapshot.restoredRoleId) ||
      (await guild.roles.fetch(snapshot.restoredRoleId).catch(() => null));

    if (!restoredRole) {
      failures.push(`${snapshot.name}: 복구된 역할을 찾을 수 없음`);
      continue;
    }

    for (const memberId of snapshot.memberIds || []) {
      const member = guild.members.cache.get(memberId);
      if (!member) {
        failures.push(`${snapshot.name}: 멤버 없음 (${memberId})`);
        continue;
      }

      try {
        if (!member.roles.cache.has(restoredRole.id)) {
          await member.roles.add(
            restoredRole,
            `역할지급: 삭제 전 보유 역할 자동 재지급 (${snapshot.name})`
          );
          successCount++;
          await sleep(200);
        }
      } catch (err) {
        failures.push(`${member.user.tag} -> ${snapshot.name}: ${err.message}`);
      }
    }
  }

  return { successCount, failures };
}

/* =========================
   격리/권한박탈
========================= */
async function removeManagementRoles(member, reason = "보안 조치") {
  const removable = member.roles.cache.filter((role) => {
    if (role.id === member.guild.id) return false;
    if (role.managed) return false;
    if (role.position >= member.guild.members.me.roles.highest.position) return false;
    if (PROTECTED_ROLE_IDS.has(role.id)) return false;

    const perms = role.permissions;
    return (
      perms.has(PermissionFlagsBits.Administrator) ||
      perms.has(PermissionFlagsBits.ManageGuild) ||
      perms.has(PermissionFlagsBits.ManageRoles) ||
      perms.has(PermissionFlagsBits.ManageChannels) ||
      perms.has(PermissionFlagsBits.BanMembers) ||
      perms.has(PermissionFlagsBits.KickMembers) ||
      perms.has(PermissionFlagsBits.ModerateMembers)
    );
  });

  const removedRoles = [];
  const failures = [];

  for (const role of removable.values()) {
    try {
      await member.roles.remove(role, reason);
      removedRoles.push({ id: role.id, name: role.name });
      await sleep(180);
    } catch (err) {
      failures.push(`${role.name}: ${err.message}`);
    }
  }

  return { removedRoles, failures };
}

async function applyQuarantine(member, reason = "보안 조치") {
  if (!QUARANTINE_ROLE_ID) {
    return { ok: false, reason: "QUARANTINE_ROLE_ID 미설정" };
  }

  const role = member.guild.roles.cache.get(QUARANTINE_ROLE_ID) ||
    await member.guild.roles.fetch(QUARANTINE_ROLE_ID).catch(() => null);

  if (!role) return { ok: false, reason: "격리 역할을 찾을 수 없음" };
  if (role.position >= member.guild.members.me.roles.highest.position) {
    return { ok: false, reason: "격리 역할이 봇보다 높음" };
  }

  try {
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, reason);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function removeQuarantine(member, reason = "관리자 명령") {
  if (!QUARANTINE_ROLE_ID) return { ok: true, skipped: true };

  const role = member.guild.roles.cache.get(QUARANTINE_ROLE_ID) ||
    await member.guild.roles.fetch(QUARANTINE_ROLE_ID).catch(() => null);

  if (!role) return { ok: false, reason: "격리 역할을 찾을 수 없음" };

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, reason);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/* =========================
   안티스팸
========================= */
function trackRecentChannel(guildId, userId, channelId) {
  const key = `${guildId}:${userId}`;
  const arr = recentUserChannels.get(key) || [];
  const next = [channelId, ...arr.filter((x) => x !== channelId)].slice(0, RECENT_CHANNEL_SCAN_LIMIT);
  recentUserChannels.set(key, next);
}

async function collectAndDeleteRecentInviteSpam(guild, userId, preferredChannelId) {
  let deletedCount = 0;
  const scanned = new Set();

  const key = `${guild.id}:${userId}`;
  const channelIds = recentUserChannels.get(key) || [];
  if (preferredChannelId && !channelIds.includes(preferredChannelId)) {
    channelIds.unshift(preferredChannelId);
  }

  for (const channelId of channelIds.slice(0, RECENT_CHANNEL_SCAN_LIMIT)) {
    if (scanned.has(channelId)) continue;
    scanned.add(channelId);

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    try {
      const fetched = await channel.messages.fetch({ limit: 50 });
      const targets = fetched.filter(
        (m) =>
          m.author?.id === userId &&
          isDiscordInviteLike(m.content) &&
          Date.now() - m.createdTimestamp <= SPAM_WINDOW_MS + 30_000
      );

      if (!targets.size) continue;

      try {
        const deleted = await channel.bulkDelete(targets, true);
        deletedCount += deleted.size;
      } catch {
        for (const msg of targets.values()) {
          try {
            await msg.delete();
            deletedCount++;
            await sleep(100);
          } catch {}
        }
      }
    } catch {}
  }

  return deletedCount;
}

async function handleSpamMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (!message.content) return;

  trackRecentChannel(message.guild.id, message.author.id, message.channelId);

  if (!isDiscordInviteLike(message.content)) return;
  if (SAFE_INVITE_CHANNEL_IDS.has(message.channelId)) return;

  const member = message.member;
  if (!member) return;
  if (isProtectedUser(member)) return;
  if (memberHasAnyRole(member, SAFE_INVITE_ROLE_IDS)) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const entry = spamTracker.get(key) || { timestamps: [], messageIds: [] };

  const now = Date.now();
  entry.timestamps = entry.timestamps.filter((t) => now - t <= SPAM_WINDOW_MS);
  entry.timestamps.push(now);
  entry.messageIds.push(message.id);
  spamTracker.set(key, entry);

  if (entry.timestamps.length < SPAM_LINK_THRESHOLD) return;

  const deletedCount = await collectAndDeleteRecentInviteSpam(
    message.guild,
    message.author.id,
    message.channelId
  );

  let timeoutOk = true;
  try {
    await member.timeout(TIMEOUT_MS_SPAM, "디스코드 링크/피싱 링크 도배 자동 차단");
  } catch (err) {
    timeoutOk = false;
    console.error("스팸 타임아웃 실패:", err);
  }

  const quarantine = await applyQuarantine(member, "디스코드 링크/피싱 링크 도배 자동 격리");

  const risk = getRiskLogData();
  risk.spamCases.unshift({
    userId: member.id,
    tag: member.user.tag,
    reason: "디스코드 링크/피싱 링크 도배 감지",
    detectedAt: nowISO(),
    deletedCount,
    timeoutOk,
    quarantineApplied: quarantine.ok,
    quarantineReason: quarantine.ok ? null : quarantine.reason,
  });
  setRiskLogData(risk);

  spamTracker.delete(key);
}

/* =========================
   안티누크 누적 추적
========================= */
function pushNukeTracker(userId) {
  const risk = getRiskLogData();
  risk.nukeTracker = risk.nukeTracker || {};
  const arr = risk.nukeTracker[userId] || [];
  const now = Date.now();
  const filtered = arr.filter((ts) => now - ts <= NUKE_WINDOW_MS);
  filtered.push(now);
  risk.nukeTracker[userId] = filtered;
  setRiskLogData(risk);
  return filtered.length;
}

/* =========================
   역할 관련 이벤트
========================= */
client.on("guildRoleCreate", async (role) => {
  try {
    await syncSingleRoleSnapshot(role.guild, role);
    console.log(`[자동저장] 역할 생성 반영: ${role.name} (${role.id})`);
  } catch (err) {
    console.error("guildRoleCreate 처리 오류:", err);
  }
});

client.on("guildRoleUpdate", async (oldRole, newRole) => {
  try {
    await syncSingleRoleSnapshot(newRole.guild, newRole);
    console.log(`[자동저장] 역할 수정 반영: ${oldRole.name} -> ${newRole.name} (${newRole.id})`);
  } catch (err) {
    console.error("guildRoleUpdate 처리 오류:", err);
  }
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    await syncMemberRolesToSnapshots(newMember);
  } catch (err) {
    console.error("guildMemberUpdate 처리 오류:", err);
  }
});

/* =========================
   역할 삭제 감지 + 즉시 격리
========================= */
client.on("guildRoleDelete", async (role) => {
  try {
    const guild = role.guild;

    console.log(`[guildRoleDelete 감지] ${role.name} (${role.id})`);

    try {
      markRoleDeletedOrCreateSnapshot(guild, role, "guildRoleDelete 이벤트로 삭제를 감지했습니다.");

      const backup = getRoleBackupData();
      const deletedCount = Object.values(backup.roles || {}).filter(
        (x) => x.isDeleted === true
      ).length;

      console.log(
        `[삭제기록저장] 역할 삭제 기록 저장 완료: ${role.name} (${role.id}) | 현재 삭제 기록 수: ${deletedCount}`
      );
    } catch (err) {
      console.error("[삭제기록저장실패]", err);
    }

    await sleep(1200);

    let entry = null;
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.RoleDelete,
        limit: 6,
      });

      entry = fetchedLogs.entries.find((e) => {
        const targetId = e.target?.id;
        const created = e.createdTimestamp || 0;
        return targetId === role.id && Date.now() - created < 15000;
      });
    } catch (err) {
      console.error("[감사로그조회실패] guildRoleDelete:", err);
      return;
    }

    if (!entry) return;

    const executorId = entry.executor?.id;
    if (!executorId) return;

    const executor = await guild.members.fetch({ user: executorId, force: true }).catch(() => null);
    if (!executor) return;
    if (isProtectedUser(executor)) return;

    const hasManageRolesRole = memberHasManageRolesRole(executor);
    const hasRiskPerms = hasHighRiskPermsNow(executor);

    console.log(
      `[안티누크판정] ${executor.user.tag} (${executor.id}) | manageRole=${hasManageRolesRole} | riskPerm=${hasRiskPerms}`
    );

    if (!hasManageRolesRole && !hasRiskPerms) return;

    const nukeCount = pushNukeTracker(executor.id);

    const { removedRoles, failures: removeFailures } = await removeManagementRoles(
      executor,
      "무단 역할 삭제 감지로 관리 권한 자동 박탈"
    );

    let timeoutOk = true;
    try {
      await executor.timeout(TIMEOUT_MS_NUKE, "무단 역할 삭제 감지로 자동 격리");
    } catch (err) {
      timeoutOk = false;
      removeFailures.push(`타임아웃 실패: ${err.message}`);
    }

    const quarantine = await applyQuarantine(executor, "무단 역할 삭제 감지로 자동 격리");

    const risk = getRiskLogData();
    risk.nukeCases.unshift({
      userId: executor.id,
      tag: executor.user.tag,
      reason: `무단 역할 삭제 감지: ${role.name}`,
      roleDeleted: { id: role.id, name: role.name },
      processedAt: nowISO(),
      removedRoles,
      removeFailures,
      timeoutUntil: timeoutOk ? new Date(Date.now() + TIMEOUT_MS_NUKE).toISOString() : null,
      timeoutOk,
      quarantineApplied: quarantine.ok,
      quarantineReason: quarantine.ok ? null : quarantine.reason,
      rapidDeleteCount: nukeCount,
      released: false,
      releasedAt: null,
    });
    setRiskLogData(risk);
  } catch (err) {
    console.error("guildRoleDelete 처리 오류:", err);
  }
});

/* =========================
   메시지 감지
========================= */
client.on("messageCreate", async (message) => {
  try {
    await handleSpamMessage(message);
  } catch (err) {
    console.error("messageCreate 처리 오류:", err);
  }
});

/* =========================
   인터랙션 처리
========================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const { commandName, guild } = interaction;

    if (!guild) {
      return interaction.reply({
        content: "서버 안에서만 사용할 수 있습니다.",
        ephemeral: true,
      });
    }

    if (commandName === "삭제된역할") {
      const deleted = getDeletedRoleSnapshots(guild.id);

      if (deleted.length === 0) {
        const backup = getRoleBackupData();
        return interaction.reply({
          content:
            "현재 삭제된 역할 기록이 없습니다.\n" +
            `guildId: ${backup.guildId || "없음"}\n` +
            `전체 저장 역할 수: ${Object.keys(backup.roles || {}).length}개\n` +
            `삭제 기록 수: 0개`,
          ephemeral: true,
        });
      }

      const lines = deleted.slice(0, 20).map((r, i) => {
        return [
          `**${i + 1}. ${r.name}**`,
          `삭제시각: ${r.deletedAt || "기록 없음"}`,
          `기존 역할 ID: ${r.oldRoleId || "없음"}`,
          `보유자 수: ${(r.memberIds || []).length}명`,
        ].join("\n");
      });

      const embed = new EmbedBuilder()
        .setTitle("삭제된 역할 목록")
        .setColor(0xff9500)
        .setDescription(lines.join("\n\n"));

      return interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    }

    if (commandName === "역할복구") {
      await interaction.deferReply({ ephemeral: true });

      const identifier = interaction.options.getString("식별자", true).trim();
      const result = await restoreSingleDeletedRole(guild, identifier);

      if (!result.ok) {
        return interaction.editReply({ content: result.reason });
      }

      return interaction.editReply({
        content:
          `역할 복구 완료\n` +
          `역할: ${result.roleName}\n` +
          `재지급: ${result.assignedCount}명\n` +
          `실패: ${result.failures.length}건`,
      });
    }

    if (commandName === "역할전체복구") {
      await interaction.deferReply({ ephemeral: true });

      const result = await restoreAllDeletedRoles(guild);

      return interaction.editReply({
        content:
          `역할 전체 복구 완료\n` +
          `복구됨: ${result.restored.length}개\n` +
          `건너뜀: ${result.skipped.length}개`,
      });
    }

    if (commandName === "역할지급") {
      await interaction.deferReply({ ephemeral: true });

      const roleName = interaction.options.getString("역할이름", false);
      const result = await reassignRestoredRoles(guild, roleName);

      return interaction.editReply({
        content:
          `역할 재지급 완료: 총 ${result.successCount}건 처리했습니다.` +
          (roleName ? `\n대상 역할: ${roleName}` : "") +
          `\n실패: ${result.failures.length}건`,
      });
    }

    if (commandName === "위험기록") {
      const type = interaction.options.getString("유형") || "all";
      const risk = getRiskLogData();
      const blocks = [];

      if (type === "all" || type === "nuke") {
        const nukeList = (risk.nukeCases || []).slice(0, 5);
        if (nukeList.length) {
          blocks.push(
            `## 누크 기록\n` +
              nukeList.map((x, i) =>
                [
                  `**${i + 1}. ${x.tag}** (<@${x.userId}>)`,
                  `사유: ${x.reason}`,
                  `처리 시각: ${x.processedAt}`,
                  `타임아웃: ${x.timeoutOk ? "성공" : "실패"}`,
                  `격리 역할: ${x.quarantineApplied ? "성공" : "실패"}`,
                  `해제 여부: ${x.released ? "해제됨" : "격리 중"}`,
                ].join("\n")
              ).join("\n\n")
          );
        }
      }

      if (type === "all" || type === "spam") {
        const spamList = (risk.spamCases || []).slice(0, 5);
        if (spamList.length) {
          blocks.push(
            `## 스팸 기록\n` +
              spamList.map((x, i) =>
                [
                  `**${i + 1}. ${x.tag}** (<@${x.userId}>)`,
                  `사유: ${x.reason}`,
                  `삭제 메시지 수: ${x.deletedCount}`,
                  `처리 시각: ${x.detectedAt}`,
                ].join("\n")
              ).join("\n\n")
          );
        }
      }

      if (!blocks.length) {
        return interaction.reply({
          content: "해당 유형의 기록이 없습니다.",
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("위험 기록")
        .setColor(0xe67e22)
        .setDescription(truncate(blocks.join("\n\n"), 4096));

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === "테러위험대상") {
      const risk = getRiskLogData();
      const nukeList = (risk.nukeCases || []).filter((x) => !x.released).slice(0, 10);

      if (!nukeList.length) {
        return interaction.reply({
          content: "현재 기록된 테러 위험 대상이 없습니다.",
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("테러 위험 대상 목록")
        .setColor(0xff3b30)
        .setDescription(
          truncate(
            nukeList
              .map((x, i) =>
                [
                  `**${i + 1}. ${x.tag}** (<@${x.userId}>)`,
                  `사유: ${x.reason}`,
                  `처리 시각: ${x.processedAt}`,
                  `해제 여부: ${x.released ? "해제됨" : "격리 중"}`,
                ].join("\n")
              )
              .join("\n\n"),
            4096
          )
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === "위험해제") {
      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser("대상", true);
      const restoreRoles = interaction.options.getBoolean("역할복원") ?? true;
      const member = await guild.members.fetch(user.id).catch(() => null);

      if (!member) {
        return interaction.editReply({ content: "해당 유저를 서버에서 찾을 수 없습니다." });
      }

      let timeoutCleared = true;
      try {
        await member.timeout(null, "관리자 명령으로 위험 해제");
      } catch {
        timeoutCleared = false;
      }

      const qResult = await removeQuarantine(member, "관리자 명령으로 위험 해제");

      const risk = getRiskLogData();
      const targetCase = (risk.nukeCases || []).find(
        (x) => x.userId === user.id && !x.released
      );

      let restoredCount = 0;
      const restoreFailures = [];

      if (restoreRoles && targetCase?.removedRoles?.length) {
        for (const roleInfo of targetCase.removedRoles) {
          const role = guild.roles.cache.get(roleInfo.id) ||
            await guild.roles.fetch(roleInfo.id).catch(() => null);

          if (!role) {
            restoreFailures.push(`${roleInfo.name}: 역할을 찾을 수 없음`);
            continue;
          }

          if (role.position >= guild.members.me.roles.highest.position) {
            restoreFailures.push(`${role.name}: 봇보다 높아서 복원 불가`);
            continue;
          }

          try {
            await member.roles.add(role, "관리자 명령으로 위험 해제 및 역할 복원");
            restoredCount++;
            await sleep(180);
          } catch (err) {
            restoreFailures.push(`${role.name}: ${err.message}`);
          }
        }
      }

      if (targetCase) {
        targetCase.released = true;
        targetCase.releasedAt = nowISO();
        targetCase.restoreRoles = restoreRoles;
        targetCase.restoreFailures = restoreFailures;
        setRiskLogData(risk);
      }

      return interaction.editReply({
        content:
          `위험 해제 완료: ${user.tag}\n` +
          `타임아웃 해제: ${timeoutCleared ? "성공" : "실패"}\n` +
          `격리 역할 해제: ${qResult.ok ? "성공" : "실패"}\n` +
          `관리 역할 복원: ${restoreRoles ? `${restoredCount}개` : "건너뜀"}\n` +
          `복원 실패: ${restoreFailures.length}건`,
      });
    }
  } catch (err) {
    console.error("명령어 처리 오류:", err);

    const msg = "명령어 처리 중 오류가 발생했습니다.";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg }).catch(() => {});
    }
    return interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

/* =========================
   자동 전체 백업 / 역할 감시
========================= */
let backupInterval = null;
let roleWatchInterval = null;

async function startAutoBackup() {
  if (backupInterval) clearInterval(backupInterval);

  backupInterval = setInterval(async () => {
    try {
      pruneRiskLogData();

      const guild =
        client.guilds.cache.get(GUILD_ID) ||
        await client.guilds.fetch(GUILD_ID).catch(() => null);

      if (!guild) return;

      const count = await backupAllRoles(guild);
      console.log(`[자동백업] 역할 ${count}개 저장 완료`);
    } catch (err) {
      console.error("[자동백업] 실패:", err);
    }
  }, AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000);
}

async function startRoleWatcher() {
  if (roleWatchInterval) clearInterval(roleWatchInterval);

  roleWatchInterval = setInterval(async () => {
    try {
      const guild =
        client.guilds.cache.get(GUILD_ID) ||
        await client.guilds.fetch(GUILD_ID).catch(() => null);

      if (!guild) return;

      const detected = await detectDeletedRolesByScan(guild);
      if (detected > 0) {
        console.log(`[역할감시] 삭제된 역할 ${detected}개 반영 완료`);
      }
    } catch (err) {
      console.error("[역할감시] 실패:", err);
    }
  }, ROLE_WATCH_INTERVAL_SECONDS * 1000);
}

/* =========================
   준비 완료
========================= */
client.once("ready", async () => {
  console.log(`로그인 완료: ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (err) {
    console.error("[명령어등록] 실패:", err);
  }

  try {
    pruneRiskLogData();

    const guild =
      client.guilds.cache.get(GUILD_ID) ||
      await client.guilds.fetch(GUILD_ID).catch(() => null);

    if (guild) {
      const count = await backupAllRoles(guild);
      rebuildRoleStateCacheForGuild(guild);
      console.log(`[시작자동저장] 역할 ${count}개 저장 완료`);
    } else {
      console.error("[시작자동저장] 길드를 찾지 못했습니다.");
    }
  } catch (err) {
    console.error("[시작자동저장] 실패:", err);
  }

  await startAutoBackup();
  await startRoleWatcher();
});

/* =========================
   시작
========================= */
(async () => {
  try {
    if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
      throw new Error("TOKEN / CLIENT_ID / GUILD_ID 환경변수를 설정하세요.");
    }

    await client.login(TOKEN);
  } catch (err) {
    console.error("봇 시작 실패:", err);
  }
})();
