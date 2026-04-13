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
  ChannelType,
  OverwriteType,
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

const DELETE_LIST_RESET_ROLE_ID = "1404646756045557860";

/* =========================
   설정값
========================= */
const SPAM_WINDOW_MS = 15 * 1000;
const SPAM_LINK_THRESHOLD = 3;

const TIMEOUT_MS_SPAM = 7 * 24 * 60 * 60 * 1000; // 1주
const TIMEOUT_MS_NUKE = 7 * 24 * 60 * 60 * 1000; // 1주

const NUKE_WINDOW_MS = 30 * 1000;
const NUKE_ACTION_THRESHOLD = 1;

const AUTO_BACKUP_INTERVAL_MINUTES = 5;
const ROLE_WATCH_INTERVAL_SECONDS = 10;
const CHANNEL_WATCH_INTERVAL_SECONDS = 10;
const RISK_LOG_KEEP_DAYS = 60;
const RECENT_CHANNEL_SCAN_LIMIT = 8;

/* =========================
   데이터 파일
========================= */
const DATA_DIR = path.join(__dirname, "data");
const ROLE_BACKUP_FILE = path.join(DATA_DIR, "role_backup.json");
const CHANNEL_BACKUP_FILE = path.join(DATA_DIR, "channel_backup.json");
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

function truncate(str, max = 1024) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
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
  return member?.permissions?.has(PermissionFlagsBits.Administrator) ?? false;
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

function canResetDeletedRoleList(member) {
  if (!member) return false;
  if (!hasAdministrator(member)) return false;
  if (member.guild.ownerId === member.id) return true;
  return member.roles.cache.has(DELETE_LIST_RESET_ROLE_ID);
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

function memberHasManageChannelsRole(member) {
  return memberHasRoleWithPermission(member, PermissionFlagsBits.ManageChannels);
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

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sortByPositionAsc(arr) {
  return [...arr].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
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

function getChannelBackupData() {
  return readJson(CHANNEL_BACKUP_FILE, {
    guildId: null,
    savedAt: null,
    channels: {},
  });
}

function setChannelBackupData(data) {
  atomicWriteJson(CHANNEL_BACKUP_FILE, data);
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
   스냅샷 생성
========================= */
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
    channelOverwrites: {},
    lastSyncedAt: nowISO(),
  };
}

function overwriteToSnapshot(ow) {
  return {
    id: ow.id,
    type: ow.type,
    allow: ow.allow.bitfield.toString(),
    deny: ow.deny.bitfield.toString(),
  };
}

function channelToSnapshot(channel) {
  const overwrites = {};
  for (const [targetId, ow] of channel.permissionOverwrites.cache.entries()) {
    overwrites[targetId] = overwriteToSnapshot(ow);
  }

  const base = {
    oldChannelId: channel.id,
    name: channel.name,
    type: channel.type,
    position: channel.position,
    parentId: channel.parentId || null,
    permissionOverwrites: overwrites,
    restoredChannelId: null,
    deletedAt: null,
    restoredAt: null,
    isDeleted: false,
    restoreFailures: [],
    lastSyncedAt: nowISO(),
  };

  if ("topic" in channel) base.topic = channel.topic ?? null;
  if ("nsfw" in channel) base.nsfw = !!channel.nsfw;
  if ("rateLimitPerUser" in channel) base.rateLimitPerUser = channel.rateLimitPerUser ?? 0;
  if ("bitrate" in channel) base.bitrate = channel.bitrate ?? null;
  if ("userLimit" in channel) base.userLimit = channel.userLimit ?? null;

  if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    base.availableTags = (channel.availableTags || []).map((tag) => ({
      id: tag.id,
      name: tag.name,
      moderated: !!tag.moderated,
      emojiId: tag.emojiId ?? null,
      emojiName: tag.emojiName ?? null,
    }));
    base.defaultForumLayout = channel.defaultForumLayout ?? null;
    base.defaultSortOrder = channel.defaultSortOrder ?? null;
    base.defaultReactionEmoji = channel.defaultReactionEmoji ?? null;
    base.defaultThreadRateLimitPerUser = channel.defaultThreadRateLimitPerUser ?? 0;
  }

  return base;
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
const roleStateCache = new Map();    // guildId -> Map(roleId, roleSnapshot)
const channelStateCache = new Map(); // guildId -> Map(channelId, channelSnapshot)

/* =========================
   슬래시 명령어
========================= */
const adminOnly = PermissionFlagsBits.Administrator;

const commands = [
  new SlashCommandBuilder()
    .setName("삭제된역할")
    .setDescription("삭제된 역할 목록을 확인합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("삭제된역할목록초기화")
    .setDescription("삭제된 역할 목록 기록을 전부 초기화합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("역할복구")
    .setDescription("삭제된 역할 중 특정 역할만 복구합니다. 이름 또는 목록 번호를 입력할 수 있습니다.")
    .addStringOption((opt) =>
      opt.setName("식별자").setDescription("복구할 역할 이름 또는 삭제된역할 목록 번호").setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("역할전체복구")
    .setDescription("삭제된 역할을 전부 복구합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("역할지급")
    .setDescription("복구된 특정 역할을 삭제 전 보유자들에게 다시 지급합니다.")
    .addStringOption((opt) =>
      opt.setName("역할이름").setDescription("특정 역할만 다시 지급하고 싶을 때 입력").setRequired(false)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("역할전체지급")
    .setDescription("복구된 모든 역할을 삭제 전 보유자들에게 다시 지급합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("역할채널권한복구")
    .setDescription("특정 역할의 채널별 권한 overwrite만 다시 복구합니다.")
    .addStringOption((opt) =>
      opt.setName("식별자").setDescription("복구할 역할 이름 또는 삭제된역할 목록 번호").setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("역할채널권한전체복구")
    .setDescription("복구된 모든 역할의 채널별 권한 overwrite를 다시 복구합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("삭제된채널")
    .setDescription("삭제된 채널 목록을 확인합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("채널복구")
    .setDescription("삭제된 특정 채널을 복구합니다.")
    .addStringOption((opt) =>
      opt.setName("식별자").setDescription("복구할 채널 이름 또는 삭제된채널 목록 번호").setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("채널전체복구")
    .setDescription("삭제된 채널을 전부 복구합니다.")
    .setDefaultMemberPermissions(adminOnly),

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
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("테러위험대상")
    .setDescription("자동 격리 및 권한 박탈된 대상 목록을 확인합니다.")
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName("위험해제")
    .setDescription("격리 및 박탈된 권한을 해제합니다.")
    .addUserOption((opt) =>
      opt.setName("대상").setDescription("해제할 대상 유저").setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt.setName("역할복원").setDescription("박탈된 관리 역할도 함께 복원할지 여부").setRequired(false)
    )
    .setDefaultMemberPermissions(adminOnly),
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
   전체 백업
========================= */
async function backupAllRoles(guild) {
  await guild.roles.fetch().catch(() => null);
  await guild.members.fetch();

  const previous = getRoleBackupData();
  const channelBackup = getChannelBackupData();

  const data = {
    guildId: guild.id,
    savedAt: nowISO(),
    roles: {},
  };

  for (const [roleId, snapshot] of Object.entries(previous.roles || {})) {
    if (snapshot?.isDeleted === true) {
      data.roles[roleId] = snapshot;
    }
  }

  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position);

  for (const role of roles.values()) {
    if (role.managed) continue;

    const memberIds = guild.members.cache
      .filter((member) => member.roles.cache.has(role.id))
      .map((member) => member.id);

    const old = previous.roles?.[role.id] || roleToSnapshot(role, []);
    const snapshot = {
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
      channelOverwrites: {},
      lastSyncedAt: nowISO(),
    };

    for (const [channelId, channelSnap] of Object.entries(channelBackup.channels || {})) {
      if (channelSnap?.isDeleted) continue;
      if (channelSnap.permissionOverwrites?.[role.id]) {
        snapshot.channelOverwrites[channelId] = channelSnap.permissionOverwrites[role.id];
      }
    }

    data.roles[role.id] = snapshot;
  }

  setRoleBackupData(data);
  rebuildRoleStateCacheForGuild(guild, data);
  return Object.keys(data.roles).length;
}

async function backupAllChannels(guild) {
  await guild.channels.fetch().catch(() => null);

  const previous = getChannelBackupData();
  const data = {
    guildId: guild.id,
    savedAt: nowISO(),
    channels: {},
  };

  for (const [channelId, snapshot] of Object.entries(previous.channels || {})) {
    if (snapshot?.isDeleted === true) {
      data.channels[channelId] = snapshot;
    }
  }

  const channels = guild.channels.cache
    .filter((ch) => !ch.isThread())
    .sort((a, b) => a.position - b.position);

  for (const channel of channels.values()) {
    const old = previous.channels?.[channel.id] || {};
    const snap = {
      ...channelToSnapshot(channel),
      restoredChannelId: old.restoredChannelId || null,
      restoredAt: old.restoredAt || null,
      isDeleted: false,
      deletedAt: null,
      restoreFailures: old.restoreFailures || [],
      lastSyncedAt: nowISO(),
    };

    data.channels[channel.id] = snap;
  }

  setChannelBackupData(data);
  rebuildChannelStateCacheForGuild(guild, data);
  return Object.keys(data.channels).length;
}

function ensureRoleBackupRoot(guildId) {
  const backup = getRoleBackupData();
  if (!backup.guildId) backup.guildId = guildId;
  if (!backup.roles) backup.roles = {};
  return backup;
}

function ensureChannelBackupRoot(guildId) {
  const backup = getChannelBackupData();
  if (!backup.guildId) backup.guildId = guildId;
  if (!backup.channels) backup.channels = {};
  return backup;
}

/* =========================
   단일 동기화
========================= */
async function syncSingleRoleSnapshot(guild, role) {
  if (!guild || !role) return;
  if (role.id === guild.id) return;
  if (role.managed) return;

  const backup = ensureRoleBackupRoot(guild.id);
  const channelBackup = getChannelBackupData();

  await guild.members.fetch().catch(() => null);

  const memberIds = guild.members.cache
    .filter((member) => member.roles.cache.has(role.id))
    .map((member) => member.id);

  const old = backup.roles[role.id] || roleToSnapshot(role, []);

  const snapshot = {
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
    channelOverwrites: {},
    lastSyncedAt: nowISO(),
  };

  for (const [channelId, channelSnap] of Object.entries(channelBackup.channels || {})) {
    if (channelSnap?.isDeleted) continue;
    if (channelSnap.permissionOverwrites?.[role.id]) {
      snapshot.channelOverwrites[channelId] = channelSnap.permissionOverwrites[role.id];
    }
  }

  backup.roles[role.id] = snapshot;
  backup.savedAt = nowISO();
  setRoleBackupData(backup);

  const guildMap = roleStateCache.get(guild.id) || new Map();
  guildMap.set(role.id, clone(snapshot));
  roleStateCache.set(guild.id, guildMap);
}

async function syncSingleChannelSnapshot(guild, channel) {
  if (!guild || !channel) return;
  if (channel.isThread()) return;

  const backup = ensureChannelBackupRoot(guild.id);
  const snapshot = {
    ...channelToSnapshot(channel),
    restoredChannelId: backup.channels[channel.id]?.restoredChannelId || null,
    restoredAt: backup.channels[channel.id]?.restoredAt || null,
    isDeleted: false,
    deletedAt: null,
    restoreFailures: backup.channels[channel.id]?.restoreFailures || [],
    lastSyncedAt: nowISO(),
  };

  backup.channels[channel.id] = snapshot;
  backup.savedAt = nowISO();
  setChannelBackupData(backup);

  const guildMap = channelStateCache.get(guild.id) || new Map();
  guildMap.set(channel.id, clone(snapshot));
  channelStateCache.set(guild.id, guildMap);

  // 역할 채널권한 정보도 즉시 갱신
  const roleBackup = ensureRoleBackupRoot(guild.id);
  for (const [targetId, ow] of Object.entries(snapshot.permissionOverwrites || {})) {
    const roleSnap = roleBackup.roles[targetId];
    if (!roleSnap) continue;
    if (!roleSnap.channelOverwrites) roleSnap.channelOverwrites = {};
    roleSnap.channelOverwrites[channel.id] = ow;
  }
  roleBackup.savedAt = nowISO();
  setRoleBackupData(roleBackup);
}

async function syncMemberRolesToSnapshots(member) {
  if (!member?.guild) return;

  const guild = member.guild;
  const backup = ensureRoleBackupRoot(guild.id);
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

/* =========================
   캐시 재구성
========================= */
function rebuildRoleStateCacheForGuild(guild, backup = null) {
  const source = backup || getRoleBackupData();
  const guildMap = new Map();

  for (const [roleId, snap] of Object.entries(source.roles || {})) {
    if (snap?.isDeleted) continue;
    guildMap.set(roleId, clone(snap));
  }

  roleStateCache.set(guild.id, guildMap);
}

function rebuildChannelStateCacheForGuild(guild, backup = null) {
  const source = backup || getChannelBackupData();
  const guildMap = new Map();

  for (const [channelId, snap] of Object.entries(source.channels || {})) {
    if (snap?.isDeleted) continue;
    guildMap.set(channelId, clone(snap));
  }

  channelStateCache.set(guild.id, guildMap);
}

/* =========================
   삭제 기록 생성
========================= */
function markRoleDeletedOrCreateSnapshot(guild, role, reasonText = null) {
  const backup = ensureRoleBackupRoot(guild.id);
  const guildMap = roleStateCache.get(guild.id) || new Map();
  const cachedBeforeDelete = guildMap.get(role.id) || null;
  const old = backup.roles[role.id];

  const preservedMemberIds =
    cachedBeforeDelete?.memberIds && Array.isArray(cachedBeforeDelete.memberIds)
      ? [...cachedBeforeDelete.memberIds]
      : old?.memberIds && Array.isArray(old.memberIds)
      ? [...old.memberIds]
      : [];

  const preservedChannelOverwrites =
    cachedBeforeDelete?.channelOverwrites
      ? clone(cachedBeforeDelete.channelOverwrites)
      : old?.channelOverwrites
      ? clone(old.channelOverwrites)
      : {};

  const target = old || {};
  target.oldRoleId = role.id;
  target.name = cachedBeforeDelete?.name ?? role.name;
  target.color = cachedBeforeDelete?.color ?? role.color;
  target.permissions =
    cachedBeforeDelete?.permissions ?? role.permissions.bitfield.toString();
  target.hoist = cachedBeforeDelete?.hoist ?? role.hoist;
  target.mentionable = cachedBeforeDelete?.mentionable ?? role.mentionable;
  target.position = cachedBeforeDelete?.position ?? role.position;
  target.managed = cachedBeforeDelete?.managed ?? role.managed;
  target.icon = cachedBeforeDelete?.icon ?? role.icon ?? null;
  target.unicodeEmoji = cachedBeforeDelete?.unicodeEmoji ?? role.unicodeEmoji ?? null;
  target.memberIds = preservedMemberIds;
  target.channelOverwrites = preservedChannelOverwrites;
  target.isDeleted = true;
  target.deletedAt = nowISO();
  target.restoredRoleId = null;
  target.restoredAt = null;
  target.lastSyncedAt = nowISO();
  if (!Array.isArray(target.restoreFailures)) target.restoreFailures = [];
  if (reasonText && !target.restoreFailures.includes(reasonText)) {
    target.restoreFailures.unshift(reasonText);
  }

  backup.roles[role.id] = target;
  backup.savedAt = nowISO();
  setRoleBackupData(backup);

  guildMap.delete(role.id);
  roleStateCache.set(guild.id, guildMap);
}

function markChannelDeletedOrCreateSnapshot(guild, channelLike, reasonText = null) {
  const backup = ensureChannelBackupRoot(guild.id);
  const guildMap = channelStateCache.get(guild.id) || new Map();
  const cachedBeforeDelete = guildMap.get(channelLike.id) || null;
  const old = backup.channels[channelLike.id];

  const target = old || {};
  target.oldChannelId = channelLike.id;
  target.name = cachedBeforeDelete?.name ?? channelLike.name;
  target.type = cachedBeforeDelete?.type ?? channelLike.type;
  target.position = cachedBeforeDelete?.position ?? channelLike.position ?? 0;
  target.parentId = cachedBeforeDelete?.parentId ?? channelLike.parentId ?? null;
  target.permissionOverwrites = clone(cachedBeforeDelete?.permissionOverwrites || old?.permissionOverwrites || {});
  target.topic = cachedBeforeDelete?.topic ?? old?.topic ?? null;
  target.nsfw = cachedBeforeDelete?.nsfw ?? old?.nsfw ?? false;
  target.rateLimitPerUser = cachedBeforeDelete?.rateLimitPerUser ?? old?.rateLimitPerUser ?? 0;
  target.bitrate = cachedBeforeDelete?.bitrate ?? old?.bitrate ?? null;
  target.userLimit = cachedBeforeDelete?.userLimit ?? old?.userLimit ?? null;
  target.availableTags = clone(cachedBeforeDelete?.availableTags || old?.availableTags || []);
  target.defaultForumLayout = cachedBeforeDelete?.defaultForumLayout ?? old?.defaultForumLayout ?? null;
  target.defaultSortOrder = cachedBeforeDelete?.defaultSortOrder ?? old?.defaultSortOrder ?? null;
  target.defaultReactionEmoji = cachedBeforeDelete?.defaultReactionEmoji ?? old?.defaultReactionEmoji ?? null;
  target.defaultThreadRateLimitPerUser =
    cachedBeforeDelete?.defaultThreadRateLimitPerUser ??
    old?.defaultThreadRateLimitPerUser ??
    0;

  target.restoredChannelId = null;
  target.restoredAt = null;
  target.isDeleted = true;
  target.deletedAt = nowISO();
  target.lastSyncedAt = nowISO();
  if (!Array.isArray(target.restoreFailures)) target.restoreFailures = [];
  if (reasonText && !target.restoreFailures.includes(reasonText)) {
    target.restoreFailures.unshift(reasonText);
  }

  backup.channels[channelLike.id] = target;
  backup.savedAt = nowISO();
  setChannelBackupData(backup);

  guildMap.delete(channelLike.id);
  channelStateCache.set(guild.id, guildMap);
}

/* =========================
   스캔 기반 삭제 감지
========================= */
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

  return deleted.length;
}

async function detectDeletedChannelsByScan(guild) {
  await guild.channels.fetch().catch(() => null);

  const currentChannelIds = new Set(
    guild.channels.cache
      .filter((ch) => !ch.isThread())
      .map((ch) => ch.id)
  );

  const cached = channelStateCache.get(guild.id) || new Map();
  const deleted = [];

  for (const [channelId, oldSnapshot] of cached.entries()) {
    if (!currentChannelIds.has(channelId)) {
      deleted.push(oldSnapshot);
    }
  }

  if (!deleted.length) return 0;

  for (const oldSnapshot of deleted) {
    markChannelDeletedOrCreateSnapshot(
      guild,
      {
        id: oldSnapshot.oldChannelId,
        name: oldSnapshot.name,
        type: oldSnapshot.type,
        position: oldSnapshot.position,
        parentId: oldSnapshot.parentId,
      },
      "주기 스캔으로 삭제된 채널을 감지했습니다."
    );

    console.log(`[채널스캔감지] 삭제된 채널 기록 반영: ${oldSnapshot.name} (${oldSnapshot.oldChannelId})`);
  }

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
    .sort((a, b) => new Date(b.deletedAt || 0).getTime() - new Date(a.deletedAt || 0).getTime());
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

function getDeletedChannelSnapshots(guildId) {
  const backup = getChannelBackupData();
  if (!backup.guildId || backup.guildId !== guildId) return [];
  return Object.values(backup.channels || {})
    .filter((c) => c.isDeleted === true)
    .sort((a, b) => new Date(b.deletedAt || 0).getTime() - new Date(a.deletedAt || 0).getTime());
}

function resolveDeletedChannelSnapshot(guildId, identifier) {
  const deleted = getDeletedChannelSnapshots(guildId);
  if (!deleted.length) return null;

  const raw = String(identifier || "").trim();
  const asNum = Number(raw);

  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= deleted.length) {
    return deleted[asNum - 1];
  }

  return deleted.find((c) => c.name === raw) || null;
}

/* =========================
   권한 overwrite 복구용
========================= */
function resolveRoleIdForOverwrite(guild, oldRoleId, roleBackup) {
  const roleSnap = roleBackup.roles?.[oldRoleId];

  if (roleSnap?.restoredRoleId && guild.roles.cache.has(roleSnap.restoredRoleId)) {
    return roleSnap.restoredRoleId;
  }

  if (guild.roles.cache.has(oldRoleId)) {
    return oldRoleId;
  }

  if (roleSnap?.name) {
    const byName = guild.roles.cache.find((r) => r.name === roleSnap.name);
    if (byName) return byName.id;
  }

  return null;
}

async function buildChannelOverwritesFromSnapshot(guild, channelSnapshot) {
  const roleBackup = getRoleBackupData();
  const overwrites = [];

  for (const ow of Object.values(channelSnapshot.permissionOverwrites || {})) {
    if (ow.type === OverwriteType.Role || ow.type === 0) {
      const resolvedRoleId = resolveRoleIdForOverwrite(guild, ow.id, roleBackup);
      if (!resolvedRoleId) continue;

      overwrites.push({
        id: resolvedRoleId,
        type: OverwriteType.Role,
        allow: BigInt(ow.allow),
        deny: BigInt(ow.deny),
      });
    } else {
      // 멤버 overwrite는 현재 서버에 멤버가 있을 때만 복원
      const memberExists = guild.members.cache.has(ow.id) || !!(await guild.members.fetch(ow.id).catch(() => null));
      if (!memberExists) continue;

      overwrites.push({
        id: ow.id,
        type: OverwriteType.Member,
        allow: BigInt(ow.allow),
        deny: BigInt(ow.deny),
      });
    }
  }

  return overwrites;
}

async function restoreRoleChannelOverwrites(guild, roleSnapshot) {
  const restoredRoleId =
    roleSnapshot.restoredRoleId && guild.roles.cache.has(roleSnapshot.restoredRoleId)
      ? roleSnapshot.restoredRoleId
      : guild.roles.cache.has(roleSnapshot.oldRoleId)
      ? roleSnapshot.oldRoleId
      : null;

  if (!restoredRoleId) {
    return {
      successCount: 0,
      failures: [`${roleSnapshot.name}: 복구된 역할 ID를 찾지 못했습니다.`],
    };
  }

  const channelBackup = getChannelBackupData();
  const failures = [];
  let successCount = 0;

  for (const [oldChannelId, ow] of Object.entries(roleSnapshot.channelOverwrites || {})) {
    const channelSnap = channelBackup.channels?.[oldChannelId];
    if (!channelSnap) {
      failures.push(`${roleSnapshot.name}: 채널 백업 없음 (${oldChannelId})`);
      continue;
    }

    const targetChannelId =
      channelSnap.restoredChannelId && guild.channels.cache.has(channelSnap.restoredChannelId)
        ? channelSnap.restoredChannelId
        : guild.channels.cache.has(oldChannelId)
        ? oldChannelId
        : null;

    if (!targetChannelId) {
      failures.push(`${roleSnapshot.name}: 대상 채널을 찾지 못함 (${channelSnap.name})`);
      continue;
    }

    const channel = guild.channels.cache.get(targetChannelId) || await guild.channels.fetch(targetChannelId).catch(() => null);
    if (!channel) {
      failures.push(`${roleSnapshot.name}: 채널 조회 실패 (${channelSnap.name})`);
      continue;
    }

    try {
      await channel.permissionOverwrites.edit(
        restoredRoleId,
        {
          allow: BigInt(ow.allow),
          deny: BigInt(ow.deny),
        },
        { reason: `역할 채널권한 복구: ${roleSnapshot.name}` }
      );
      successCount++;
      await sleep(120);
    } catch (err) {
      failures.push(`${roleSnapshot.name} -> ${channel.name}: ${err.message}`);
    }
  }

  return { successCount, failures };
}

async function restoreAllRoleChannelOverwrites(guild) {
  const roleBackup = getRoleBackupData();
  let successCount = 0;
  const failures = [];

  for (const snapshot of Object.values(roleBackup.roles || {})) {
    if (!snapshot.restoredRoleId && !guild.roles.cache.has(snapshot.oldRoleId)) continue;
    const result = await restoreRoleChannelOverwrites(guild, snapshot);
    successCount += result.successCount;
    failures.push(...result.failures);
  }

  return { successCount, failures };
}

/* =========================
   채널 복구
========================= */
async function createChannelFromSnapshot(guild, snapshot) {
  const overwrites = await buildChannelOverwritesFromSnapshot(guild, snapshot);

  const createPayload = {
    name: snapshot.name,
    type: snapshot.type,
    position: snapshot.position,
    permissionOverwrites: overwrites,
    reason: `채널 복구: ${snapshot.name}`,
  };

  const parentRestoredId = resolveRestoredParentId(guild, snapshot.parentId);
  if (parentRestoredId) createPayload.parent = parentRestoredId;

  if (snapshot.topic != null) createPayload.topic = snapshot.topic;
  if (snapshot.nsfw != null) createPayload.nsfw = snapshot.nsfw;
  if (snapshot.rateLimitPerUser != null) createPayload.rateLimitPerUser = snapshot.rateLimitPerUser;
  if (snapshot.bitrate != null) createPayload.bitrate = snapshot.bitrate;
  if (snapshot.userLimit != null) createPayload.userLimit = snapshot.userLimit;

  if (snapshot.type === ChannelType.GuildForum || snapshot.type === ChannelType.GuildMedia) {
    if (Array.isArray(snapshot.availableTags)) createPayload.availableTags = snapshot.availableTags;
    if (snapshot.defaultForumLayout != null) createPayload.defaultForumLayout = snapshot.defaultForumLayout;
    if (snapshot.defaultSortOrder != null) createPayload.defaultSortOrder = snapshot.defaultSortOrder;
    if (snapshot.defaultReactionEmoji != null) createPayload.defaultReactionEmoji = snapshot.defaultReactionEmoji;
    if (snapshot.defaultThreadRateLimitPerUser != null) {
      createPayload.defaultThreadRateLimitPerUser = snapshot.defaultThreadRateLimitPerUser;
    }
  }

  const newChannel = await guild.channels.create(createPayload);
  await sleep(500);

  try {
    await newChannel.setPosition(snapshot.position);
  } catch {}

  return newChannel;
}

function resolveRestoredParentId(guild, oldParentId) {
  if (!oldParentId) return null;

  const channelBackup = getChannelBackupData();
  const parentSnap = channelBackup.channels?.[oldParentId];
  if (!parentSnap) {
    return guild.channels.cache.has(oldParentId) ? oldParentId : null;
  }

  if (parentSnap.restoredChannelId && guild.channels.cache.has(parentSnap.restoredChannelId)) {
    return parentSnap.restoredChannelId;
  }

  if (guild.channels.cache.has(oldParentId)) return oldParentId;

  const byName = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === parentSnap.name
  );
  return byName?.id || null;
}

async function restoreSingleDeletedChannel(guild, identifier) {
  const backup = getChannelBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 채널 백업 데이터가 없습니다.");
  }

  const snapshot = resolveDeletedChannelSnapshot(guild.id, identifier);
  if (!snapshot) {
    return { ok: false, reason: "삭제된 기록이 있는 해당 채널을 찾지 못했습니다." };
  }

  const existing = guild.channels.cache.find((c) => c.name === snapshot.name && c.type === snapshot.type);
  if (existing) {
    return {
      ok: false,
      reason: `이미 서버에 "${snapshot.name}" 채널이 존재하여 중복 생성하지 않았습니다.`,
    };
  }

  const newChannel = await createChannelFromSnapshot(guild, snapshot);

  snapshot.restoredChannelId = newChannel.id;
  snapshot.restoredAt = nowISO();
  snapshot.isDeleted = false;
  snapshot.restoreFailures = [];
  setChannelBackupData(backup);

  const guildMap = channelStateCache.get(guild.id) || new Map();
  guildMap.set(newChannel.id, {
    ...snapshot,
    oldChannelId: newChannel.id,
    restoredChannelId: newChannel.id,
    isDeleted: false,
  });
  channelStateCache.set(guild.id, guildMap);

  return {
    ok: true,
    channelName: snapshot.name,
    channelId: newChannel.id,
  };
}

async function restoreAllDeletedChannels(guild) {
  const backup = getChannelBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 채널 백업 데이터가 없습니다.");
  }

  const deletedSnapshots = sortByPositionAsc(
    Object.values(backup.channels || {}).filter((c) => c.isDeleted === true)
  );

  const restored = [];
  const skipped = [];

  // 카테고리 먼저
  const categories = deletedSnapshots.filter((c) => c.type === ChannelType.GuildCategory);
  const others = deletedSnapshots.filter((c) => c.type !== ChannelType.GuildCategory);

  for (const snapshot of [...categories, ...others]) {
    const existing = guild.channels.cache.find((c) => c.name === snapshot.name && c.type === snapshot.type);
    if (existing) {
      skipped.push({ name: snapshot.name, reason: "이미 같은 이름/타입의 채널이 존재함" });
      continue;
    }

    try {
      const newChannel = await createChannelFromSnapshot(guild, snapshot);
      snapshot.restoredChannelId = newChannel.id;
      snapshot.restoredAt = nowISO();
      snapshot.isDeleted = false;
      snapshot.restoreFailures = [];
      restored.push({ name: snapshot.name });

      const guildMap = channelStateCache.get(guild.id) || new Map();
      guildMap.set(newChannel.id, {
        ...snapshot,
        oldChannelId: newChannel.id,
        restoredChannelId: newChannel.id,
        isDeleted: false,
      });
      channelStateCache.set(guild.id, guildMap);
    } catch (err) {
      skipped.push({ name: snapshot.name, reason: err.message || "복구 중 오류 발생" });
    }
  }

  setChannelBackupData(backup);
  return { restored, skipped };
}

/* =========================
   역할 지급
========================= */
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

    const memberIds = Array.isArray(snapshot.memberIds) ? snapshot.memberIds : [];

    for (const memberId of memberIds) {
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
          await sleep(150);
        }
      } catch (err) {
        failures.push(`${member.user.tag} -> ${snapshot.name}: ${err.message}`);
      }
    }
  }

  return { successCount, failures };
}

async function reassignAllRestoredRoles(guild) {
  const backup = getRoleBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 역할 백업 데이터가 없습니다.");
  }

  await guild.members.fetch();

  let successCount = 0;
  const failures = [];
  const details = [];

  for (const snapshot of Object.values(backup.roles || {})) {
    if (!snapshot.restoredRoleId) continue;

    const restoredRole =
      guild.roles.cache.get(snapshot.restoredRoleId) ||
      (await guild.roles.fetch(snapshot.restoredRoleId).catch(() => null));

    if (!restoredRole) {
      failures.push(`${snapshot.name}: 복구된 역할을 찾을 수 없음`);
      continue;
    }

    const memberIds = Array.isArray(snapshot.memberIds) ? snapshot.memberIds : [];

    for (const memberId of memberIds) {
      const member = guild.members.cache.get(memberId);
      if (!member) {
        failures.push(`${snapshot.name}: 멤버 없음 (${memberId})`);
        continue;
      }

      try {
        if (!member.roles.cache.has(restoredRole.id)) {
          await member.roles.add(
            restoredRole,
            `역할전체지급: 삭제 전 보유 역할 자동 재지급 (${snapshot.name})`
          );
          successCount++;
          details.push(`${member.user.tag} -> ${snapshot.name}`);
          await sleep(150);
        }
      } catch (err) {
        failures.push(`${member.user.tag} -> ${snapshot.name}: ${err.message}`);
      }
    }
  }

  return { successCount, failures, details };
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
      await sleep(120);
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
            await sleep(80);
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

async function processPotentialNuke(guild, executorId, reasonText, deletedObject) {
  const executor = await guild.members.fetch({ user: executorId, force: true }).catch(() => null);
  if (!executor) return;
  if (isProtectedUser(executor)) return;

  const hasManageRolesRole = memberHasManageRolesRole(executor);
  const hasManageChannelsRole = memberHasManageChannelsRole(executor);
  const hasRiskPerms = hasHighRiskPermsNow(executor);

  if (!hasManageRolesRole && !hasManageChannelsRole && !hasRiskPerms) return;

  const actionCount = pushNukeTracker(executor.id);
  if (actionCount < NUKE_ACTION_THRESHOLD) return;

  const { removedRoles, failures: removeFailures } = await removeManagementRoles(
    executor,
    "누크 의심 행위 감지로 관리 권한 자동 박탈"
  );

  let timeoutOk = true;
  try {
    await executor.timeout(TIMEOUT_MS_NUKE, "누크 의심 행위 감지로 자동 격리");
  } catch (err) {
    timeoutOk = false;
    removeFailures.push(`타임아웃 실패: ${err.message}`);
  }

  const quarantine = await applyQuarantine(executor, "누크 의심 행위 감지로 자동 격리");

  const risk = getRiskLogData();
  risk.nukeCases.unshift({
    userId: executor.id,
    tag: executor.user.tag,
    reason: reasonText,
    deletedObject,
    processedAt: nowISO(),
    removedRoles,
    removeFailures,
    timeoutUntil: timeoutOk ? new Date(Date.now() + TIMEOUT_MS_NUKE).toISOString() : null,
    timeoutOk,
    quarantineApplied: quarantine.ok,
    quarantineReason: quarantine.ok ? null : quarantine.reason,
    rapidDeleteCount: actionCount,
    released: false,
    releasedAt: null,
  });
  setRiskLogData(risk);
}

/* =========================
   역할/채널 이벤트
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

client.on("guildRoleDelete", async (role) => {
  try {
    const guild = role.guild;
    console.log(`[guildRoleDelete 감지] ${role.name} (${role.id})`);

    markRoleDeletedOrCreateSnapshot(guild, role, "guildRoleDelete 이벤트로 삭제를 감지했습니다.");

    await sleep(1200);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.RoleDelete,
      limit: 6,
    }).catch(() => null);

    const entry = logs?.entries.find((e) => {
      const targetId = e.target?.id;
      const created = e.createdTimestamp || 0;
      return targetId === role.id && Date.now() - created < 15000;
    });

    if (entry?.executor?.id) {
      await processPotentialNuke(
        guild,
        entry.executor.id,
        `무단 역할 삭제 감지: ${role.name}`,
        { type: "role", id: role.id, name: role.name }
      );
    }
  } catch (err) {
    console.error("guildRoleDelete 처리 오류:", err);
  }
});

client.on("channelCreate", async (channel) => {
  try {
    if (channel.isThread()) return;
    await syncSingleChannelSnapshot(channel.guild, channel);
    console.log(`[자동저장] 채널 생성 반영: ${channel.name} (${channel.id})`);
  } catch (err) {
    console.error("channelCreate 처리 오류:", err);
  }
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  try {
    if (newChannel.isThread()) return;
    await syncSingleChannelSnapshot(newChannel.guild, newChannel);
    console.log(`[자동저장] 채널 수정 반영: ${oldChannel.name} -> ${newChannel.name} (${newChannel.id})`);
  } catch (err) {
    console.error("channelUpdate 처리 오류:", err);
  }
});

client.on("channelDelete", async (channel) => {
  try {
    if (channel.isThread()) return;

    const guild = channel.guild;
    console.log(`[channelDelete 감지] ${channel.name} (${channel.id})`);

    markChannelDeletedOrCreateSnapshot(
      guild,
      channel,
      "channelDelete 이벤트로 삭제를 감지했습니다."
    );

    await sleep(1200);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.ChannelDelete,
      limit: 6,
    }).catch(() => null);

    const entry = logs?.entries.find((e) => {
      const targetId = e.target?.id;
      const created = e.createdTimestamp || 0;
      return targetId === channel.id && Date.now() - created < 15000;
    });

    if (entry?.executor?.id) {
      await processPotentialNuke(
        guild,
        entry.executor.id,
        `무단 채널 삭제 감지: ${channel.name}`,
        { type: "channel", id: channel.id, name: channel.name }
      );
    }
  } catch (err) {
    console.error("channelDelete 처리 오류:", err);
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

    const member = interaction.member;
    if (!hasAdministrator(member)) {
      return interaction.reply({
        content: "이 명령어는 관리자 권한이 있는 사람만 사용할 수 있습니다.",
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
        const holders =
          (r.memberIds || []).length > 0
            ? r.memberIds.slice(0, 10).map((id) => `<@${id}>`).join(", ")
            : "없음";

        return [
          `**${i + 1}. ${r.name}**`,
          `삭제시각: ${r.deletedAt || "기록 없음"}`,
          `기존 역할 ID: ${r.oldRoleId || "없음"}`,
          `삭제 전 보유자 수: ${(r.memberIds || []).length}명`,
          `삭제 전 보유자: ${holders}`,
        ].join("\n");
      });

      const embed = new EmbedBuilder()
        .setTitle("삭제된 역할 목록")
        .setColor(0xff9500)
        .setDescription(lines.join("\n\n"));

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === "삭제된역할목록초기화") {
      if (!canResetDeletedRoleList(member)) {
        return interaction.reply({
          content: "이 명령어는 관리자 권한이 있으면서 서버 주인 또는 지정된 역할 보유자만 사용할 수 있습니다.",
          ephemeral: true,
        });
      }

      const backup = getRoleBackupData();
      const beforeCount = Object.values(backup.roles || {}).filter((x) => x.isDeleted === true).length;

      for (const roleId of Object.keys(backup.roles || {})) {
        if (backup.roles[roleId]?.isDeleted === true) {
          delete backup.roles[roleId];
        }
      }

      backup.savedAt = nowISO();
      setRoleBackupData(backup);

      return interaction.reply({
        content: `삭제된 역할 목록 초기화 완료: ${beforeCount}개의 삭제 기록을 제거했습니다.`,
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
          `역할 지급 완료\n` +
          `재지급 건수: ${result.successCount}건` +
          (roleName ? `\n대상 역할: ${roleName}` : "") +
          `\n실패: ${result.failures.length}건`,
      });
    }

    if (commandName === "역할전체지급") {
      await interaction.deferReply({ ephemeral: true });

      const result = await reassignAllRestoredRoles(guild);

      return interaction.editReply({
        content:
          `역할 전체 지급 완료\n` +
          `재지급 건수: ${result.successCount}건\n` +
          `실패: ${result.failures.length}건`,
      });
    }

    if (commandName === "역할채널권한복구") {
      await interaction.deferReply({ ephemeral: true });

      const identifier = interaction.options.getString("식별자", true).trim();
      const snapshot = resolveDeletedRoleSnapshot(guild.id, identifier) ||
        Object.values(getRoleBackupData().roles || {}).find((r) => r.name === identifier || String(r.restoredRoleId) === identifier);

      if (!snapshot) {
        return interaction.editReply({ content: "대상 역할 기록을 찾지 못했습니다." });
      }

      const result = await restoreRoleChannelOverwrites(guild, snapshot);
      return interaction.editReply({
        content:
          `역할 채널권한 복구 완료\n` +
          `적용 건수: ${result.successCount}건\n` +
          `실패: ${result.failures.length}건`,
      });
    }

    if (commandName === "역할채널권한전체복구") {
      await interaction.deferReply({ ephemeral: true });

      const result = await restoreAllRoleChannelOverwrites(guild);
      return interaction.editReply({
        content:
          `역할 채널권한 전체 복구 완료\n` +
          `적용 건수: ${result.successCount}건\n` +
          `실패: ${result.failures.length}건`,
      });
    }

    if (commandName === "삭제된채널") {
      const deleted = getDeletedChannelSnapshots(guild.id);

      if (deleted.length === 0) {
        const backup = getChannelBackupData();
        return interaction.reply({
          content:
            "현재 삭제된 채널 기록이 없습니다.\n" +
            `guildId: ${backup.guildId || "없음"}\n` +
            `전체 저장 채널 수: ${Object.keys(backup.channels || {}).length}개\n` +
            `삭제 기록 수: 0개`,
          ephemeral: true,
        });
      }

      const lines = deleted.slice(0, 20).map((c, i) => {
        return [
          `**${i + 1}. ${c.name}**`,
          `삭제시각: ${c.deletedAt || "기록 없음"}`,
          `기존 채널 ID: ${c.oldChannelId || "없음"}`,
          `타입: ${c.type}`,
          `상위 카테고리 ID: ${c.parentId || "없음"}`,
        ].join("\n");
      });

      const embed = new EmbedBuilder()
        .setTitle("삭제된 채널 목록")
        .setColor(0xff6b6b)
        .setDescription(lines.join("\n\n"));

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === "채널복구") {
      await interaction.deferReply({ ephemeral: true });

      const identifier = interaction.options.getString("식별자", true).trim();
      const result = await restoreSingleDeletedChannel(guild, identifier);

      if (!result.ok) {
        return interaction.editReply({ content: result.reason });
      }

      return interaction.editReply({
        content:
          `채널 복구 완료\n` +
          `채널: ${result.channelName}`,
      });
    }

    if (commandName === "채널전체복구") {
      await interaction.deferReply({ ephemeral: true });

      const result = await restoreAllDeletedChannels(guild);

      return interaction.editReply({
        content:
          `채널 전체 복구 완료\n` +
          `복구됨: ${result.restored.length}개\n` +
          `건너뜀: ${result.skipped.length}개\n` +
          `주의: 삭제된 메시지 내용은 복구되지 않습니다.`,
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
      const targetMember = await guild.members.fetch(user.id).catch(() => null);

      if (!targetMember) {
        return interaction.editReply({ content: "해당 유저를 서버에서 찾을 수 없습니다." });
      }

      let timeoutCleared = true;
      try {
        await targetMember.timeout(null, "관리자 명령으로 위험 해제");
      } catch {
        timeoutCleared = false;
      }

      const qResult = await removeQuarantine(targetMember, "관리자 명령으로 위험 해제");

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
            await targetMember.roles.add(role, "관리자 명령으로 위험 해제 및 역할 복원");
            restoredCount++;
            await sleep(120);
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
   자동 백업 / 감시
========================= */
let backupInterval = null;
let roleWatchInterval = null;
let channelWatchInterval = null;

async function startAutoBackup() {
  if (backupInterval) clearInterval(backupInterval);

  backupInterval = setInterval(async () => {
    try {
      pruneRiskLogData();

      const guild =
        client.guilds.cache.get(GUILD_ID) ||
        await client.guilds.fetch(GUILD_ID).catch(() => null);

      if (!guild) return;

      const roleCount = await backupAllRoles(guild);
      const channelCount = await backupAllChannels(guild);

      console.log(`[자동백업] 역할 ${roleCount}개 / 채널 ${channelCount}개 저장 완료`);
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

async function startChannelWatcher() {
  if (channelWatchInterval) clearInterval(channelWatchInterval);

  channelWatchInterval = setInterval(async () => {
    try {
      const guild =
        client.guilds.cache.get(GUILD_ID) ||
        await client.guilds.fetch(GUILD_ID).catch(() => null);

      if (!guild) return;

      const detected = await detectDeletedChannelsByScan(guild);
      if (detected > 0) {
        console.log(`[채널감시] 삭제된 채널 ${detected}개 반영 완료`);
      }
    } catch (err) {
      console.error("[채널감시] 실패:", err);
    }
  }, CHANNEL_WATCH_INTERVAL_SECONDS * 1000);
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
      const roleCount = await backupAllRoles(guild);
      const channelCount = await backupAllChannels(guild);

      rebuildRoleStateCacheForGuild(guild);
      rebuildChannelStateCacheForGuild(guild);

      console.log(`[시작자동저장] 역할 ${roleCount}개 / 채널 ${channelCount}개 저장 완료`);
    } else {
      console.error("[시작자동저장] 길드를 찾지 못했습니다.");
    }
  } catch (err) {
    console.error("[시작자동저장] 실패:", err);
  }

  await startAutoBackup();
  await startRoleWatcher();
  await startChannelWatcher();
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
