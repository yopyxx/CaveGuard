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

// 최상위 관리자/예외 유저
const SUPER_ADMIN_IDS = new Set([
  // "123456789012345678",
]);

/* =========================
   설정값
========================= */

// 안티스팸
const SPAM_WINDOW_MS = 15 * 1000; // 15초
const SPAM_LINK_THRESHOLD = 3; // 15초 내 3개 이상
const TIMEOUT_MS_SPAM = 30 * 60 * 1000; // 30분

// 안티누크
const TIMEOUT_MS_NUKE = 7 * 24 * 60 * 60 * 1000; // 1주

// 역할 자동 백업 주기 (분)
const AUTO_BACKUP_INTERVAL_MINUTES = 30;

// 로그 채널 ID (없으면 비활성)
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

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

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDiscordInviteLike(content) {
  if (!content) return false;
  const text = content.toLowerCase();

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

function hasManageRoles(member) {
  return member.permissions.has(PermissionFlagsBits.ManageRoles);
}

function getManageRolesOnly(member) {
  return hasManageRoles(member) && !hasAdministrator(member);
}

function isProtectedUser(member) {
  if (!member) return false;
  if (SUPER_ADMIN_IDS.has(member.id)) return true;
  if (member.guild.ownerId === member.id) return true;
  if (hasAdministrator(member)) return true;
  return false;
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
  };
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
  writeJson(ROLE_BACKUP_FILE, data);
}

function getRiskLogData() {
  return readJson(RISK_LOG_FILE, {
    nukeCases: [],
    spamCases: [],
  });
}

function setRiskLogData(data) {
  writeJson(RISK_LOG_FILE, data);
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

/* =========================
   슬래시 명령어
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("역할저장")
    .setDescription("현재 서버의 역할과 역할 보유자 정보를 저장합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("삭제된역할")
    .setDescription("삭제된 역할 목록을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("역할복구")
    .setDescription("삭제된 역할 중 특정 역할만 복구합니다.")
    .addStringOption((opt) =>
      opt
        .setName("역할이름")
        .setDescription("복구할 역할 이름")
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("슬래시 명령어 등록 완료");
}

/* =========================
   역할 백업
========================= */
async function backupAllRoles(guild) {
  await guild.members.fetch();

  const data = {
    guildId: guild.id,
    savedAt: nowISO(),
    roles: {},
  };

  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id) // @everyone 제외
    .sort((a, b) => b.position - a.position);

  for (const role of roles.values()) {
    if (role.managed) continue;

    const memberIds = guild.members.cache
      .filter((member) => member.roles.cache.has(role.id))
      .map((member) => member.id);

    data.roles[role.id] = roleToSnapshot(role, memberIds);
  }

  setRoleBackupData(data);
  return Object.keys(data.roles).length;
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

/* =========================
   단건 역할 복구
========================= */
async function restoreSingleDeletedRole(guild, roleName) {
  const backup = getRoleBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 역할 백업 데이터가 없습니다.");
  }

  const normalized = roleName.trim();

  const snapshots = Object.values(backup.roles || {});
  const snapshot = snapshots.find(
    (r) => r.isDeleted === true && r.name === normalized
  );

  if (!snapshot) {
    return {
      ok: false,
      reason: "삭제된 기록이 있는 해당 역할을 찾지 못했습니다.",
    };
  }

  const existingRole = guild.roles.cache.find((r) => r.name === snapshot.name);
  if (existingRole) {
    return {
      ok: false,
      reason: `이미 서버에 "${snapshot.name}" 역할이 존재하여 중복 생성하지 않았습니다.`,
    };
  }

  const createPayload = {
    name: snapshot.name,
    color: snapshot.color,
    permissions: BigInt(snapshot.permissions),
    hoist: snapshot.hoist,
    mentionable: snapshot.mentionable,
    reason: `정밀 역할 복구: ${snapshot.name}`,
  };

  if (snapshot.icon) createPayload.icon = snapshot.icon;
  if (snapshot.unicodeEmoji) createPayload.unicodeEmoji = snapshot.unicodeEmoji;

  const newRole = await guild.roles.create(createPayload);
  await sleep(700);

  try {
    await newRole.setPosition(snapshot.position, `정밀 역할 복구 위치 복원: ${snapshot.name}`);
  } catch {}

  snapshot.restoredRoleId = newRole.id;
  snapshot.restoredAt = nowISO();
  snapshot.isDeleted = false;

  setRoleBackupData(backup);

  let assignedCount = 0;
  await guild.members.fetch();

  for (const memberId of snapshot.memberIds || []) {
    const member = guild.members.cache.get(memberId);
    if (!member) continue;

    try {
      if (!member.roles.cache.has(newRole.id)) {
        await member.roles.add(newRole, `정밀 역할 복구 자동 재지급: ${snapshot.name}`);
        assignedCount++;
        await sleep(350);
      }
    } catch {}
  }

  return {
    ok: true,
    roleName: snapshot.name,
    roleId: newRole.id,
    assignedCount,
  };
}

/* =========================
   전체 역할 복구
========================= */
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
      skipped.push({
        name: snapshot.name,
        reason: "이미 같은 이름의 역할이 서버에 존재함",
      });
      continue;
    }

    try {
      const createPayload = {
        name: snapshot.name,
        color: snapshot.color,
        permissions: BigInt(snapshot.permissions),
        hoist: snapshot.hoist,
        mentionable: snapshot.mentionable,
        reason: `역할전체복구: ${snapshot.name}`,
      };

      if (snapshot.icon) createPayload.icon = snapshot.icon;
      if (snapshot.unicodeEmoji) createPayload.unicodeEmoji = snapshot.unicodeEmoji;

      const newRole = await guild.roles.create(createPayload);
      await sleep(700);

      try {
        await newRole.setPosition(snapshot.position, `역할전체복구 위치 복원: ${snapshot.name}`);
      } catch {}

      snapshot.restoredRoleId = newRole.id;
      snapshot.restoredAt = nowISO();
      snapshot.isDeleted = false;

      let assignedCount = 0;

      for (const memberId of snapshot.memberIds || []) {
        const member = guild.members.cache.get(memberId);
        if (!member) continue;

        try {
          if (!member.roles.cache.has(newRole.id)) {
            await member.roles.add(newRole, `역할전체복구 자동 재지급: ${snapshot.name}`);
            assignedCount++;
            await sleep(350);
          }
        } catch {}
      }

      restored.push({
        name: snapshot.name,
        assignedCount,
      });
    } catch (err) {
      console.error(`역할 복구 실패: ${snapshot.name}`, err);
      skipped.push({
        name: snapshot.name,
        reason: "복구 중 오류 발생",
      });
    }
  }

  setRoleBackupData(backup);

  return { restored, skipped };
}

/* =========================
   복구된 역할 수동 재지급
========================= */
async function reassignRestoredRoles(guild) {
  const backup = getRoleBackupData();

  if (!backup.guildId || backup.guildId !== guild.id) {
    throw new Error("이 서버의 역할 백업 데이터가 없습니다.");
  }

  await guild.members.fetch();

  let successCount = 0;
  const details = [];

  for (const snapshot of Object.values(backup.roles || {})) {
    if (!snapshot.restoredRoleId) continue;

    const restoredRole =
      guild.roles.cache.get(snapshot.restoredRoleId) ||
      (await guild.roles.fetch(snapshot.restoredRoleId).catch(() => null));

    if (!restoredRole) continue;

    for (const memberId of snapshot.memberIds || []) {
      const member = guild.members.cache.get(memberId);
      if (!member) continue;

      try {
        if (!member.roles.cache.has(restoredRole.id)) {
          await member.roles.add(
            restoredRole,
            `역할지급: 삭제 전 보유 역할 자동 재지급 (${snapshot.name})`
          );
          successCount++;
          details.push(`${member.user.tag} -> ${snapshot.name}`);
          await sleep(300);
        }
      } catch {}
    }
  }

  return { successCount, details };
}

/* =========================
   관리 역할 박탈
========================= */
async function removeManagementRoles(member, reason = "보안 조치") {
  const removable = member.roles.cache.filter((role) => {
    if (role.id === member.guild.id) return false;
    if (role.managed) return false;
    if (role.position >= member.guild.members.me.roles.highest.position) return false;

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

  for (const role of removable.values()) {
    try {
      await member.roles.remove(role, reason);
      removedRoles.push({
        id: role.id,
        name: role.name,
      });
      await sleep(250);
    } catch {}
  }

  return removedRoles;
}

/* =========================
   안티스팸
========================= */
async function handleSpamMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (!message.content) return;
  if (!isDiscordInviteLike(message.content)) return;

  const member = message.member;
  if (!member) return;
  if (isProtectedUser(member)) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const entry = spamTracker.get(key) || { timestamps: [], messageIds: [] };

  const now = Date.now();
  entry.timestamps = entry.timestamps.filter((t) => now - t <= SPAM_WINDOW_MS);
  entry.messageIds = entry.messageIds.slice(-20);

  entry.timestamps.push(now);
  entry.messageIds.push(message.id);
  spamTracker.set(key, entry);

  if (entry.timestamps.length < SPAM_LINK_THRESHOLD) return;

  let deletedCount = 0;

  try {
    const fetched = await message.channel.messages.fetch({ limit: 50 });

    const targets = fetched.filter(
      (m) =>
        m.author.id === message.author.id &&
        isDiscordInviteLike(m.content) &&
        Date.now() - m.createdTimestamp <= SPAM_WINDOW_MS + 30_000
    );

    if (targets.size > 0) {
      try {
        const deleted = await message.channel.bulkDelete(targets, true);
        deletedCount = deleted.size;
      } catch {
        for (const msg of targets.values()) {
          await msg.delete().catch(() => {});
          deletedCount++;
          await sleep(120);
        }
      }
    }
  } catch {}

  try {
    await member.timeout(TIMEOUT_MS_SPAM, "디스코드 링크/피싱 링크 도배 자동 차단");
  } catch {}

  const risk = getRiskLogData();
  risk.spamCases.unshift({
    userId: member.id,
    tag: member.user.tag,
    reason: "디스코드 링크/피싱 링크 도배 감지",
    detectedAt: nowISO(),
    deletedCount,
    action: "타임아웃 및 메시지 삭제",
  });
  setRiskLogData(risk);

  const embed = new EmbedBuilder()
    .setTitle("안티스팸 자동 조치")
    .setColor(0xffa500)
    .setDescription(
      [
        `대상: <@${member.id}>`,
        `사유: 디스코드 링크/피싱 링크 도배 감지`,
        `삭제 메시지 수: ${deletedCount}`,
        `처리 시각: ${nowISO()}`,
      ].join("\n")
    );

  await sendLog(message.guild, embed);
  spamTracker.delete(key);
}

/* =========================
   역할 삭제 감지 + 안티누크
========================= */
client.on("guildRoleDelete", async (role) => {
  try {
    const guild = role.guild;
    await sleep(1200);

    const fetchedLogs = await guild.fetchAuditLogs({
      type: AuditLogEvent.RoleDelete,
      limit: 6,
    });

    const entry = fetchedLogs.entries.find((e) => {
      const targetId = e.target?.id;
      const created = e.createdTimestamp || 0;
      return targetId === role.id && Date.now() - created < 15000;
    });

    // 백업 데이터에 삭제 표시
    const backup = getRoleBackupData();
    if (backup.roles?.[role.id]) {
      backup.roles[role.id].isDeleted = true;
      backup.roles[role.id].deletedAt = nowISO();
      backup.roles[role.id].restoredRoleId = null;
      backup.roles[role.id].restoredAt = null;
      setRoleBackupData(backup);
    }

    if (!entry) {
      const embed = new EmbedBuilder()
        .setTitle("역할 삭제 감지")
        .setColor(0xffcc00)
        .setDescription(
          [
            `삭제된 역할: ${role.name}`,
            `역할 ID: ${role.id}`,
            `실행자: 확인 실패`,
            `처리 시각: ${nowISO()}`,
          ].join("\n")
        );

      await sendLog(guild, embed);
      return;
    }

    const executorId = entry.executor?.id;
    if (!executorId) return;

    const executor = await guild.members.fetch(executorId).catch(() => null);

    const baseEmbed = new EmbedBuilder()
      .setTitle("역할 삭제 감지")
      .setColor(0xff3b30)
      .setDescription(
        [
          `삭제된 역할: ${role.name}`,
          `역할 ID: ${role.id}`,
          `실행자: <@${executorId}>`,
          `처리 시각: ${nowISO()}`,
        ].join("\n")
      );

    await sendLog(guild, baseEmbed);

    if (!executor) return;
    if (isProtectedUser(executor)) return;
    if (!getManageRolesOnly(executor)) return;

    const removedRoles = await removeManagementRoles(
      executor,
      "무단 역할 삭제 감지로 관리 권한 자동 박탈"
    );

    try {
      await executor.timeout(TIMEOUT_MS_NUKE, "무단 역할 삭제 감지로 자동 격리");
    } catch {}

    const risk = getRiskLogData();
    risk.nukeCases.unshift({
      userId: executor.id,
      tag: executor.user.tag,
      reason: `무단 역할 삭제 감지: ${role.name}`,
      roleDeleted: {
        id: role.id,
        name: role.name,
      },
      processedAt: nowISO(),
      removedRoles,
      timeoutUntil: new Date(Date.now() + TIMEOUT_MS_NUKE).toISOString(),
      released: false,
      releasedAt: null,
    });
    setRiskLogData(risk);

    const punishEmbed = new EmbedBuilder()
      .setTitle("안티누크 자동 조치")
      .setColor(0xff0000)
      .setDescription(
        [
          `대상: <@${executor.id}>`,
          `사유: 관리자 권한 없이 역할 삭제`,
          `삭제한 역할: ${role.name}`,
          `박탈된 관리 역할 수: ${removedRoles.length}`,
          `타임아웃: 1주`,
          `처리 시각: ${nowISO()}`,
        ].join("\n")
      );

    await sendLog(guild, punishEmbed);
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

    if (commandName === "역할저장") {
      await interaction.deferReply({ ephemeral: true });

      const count = await backupAllRoles(guild);

      const embed = new EmbedBuilder()
        .setTitle("역할 저장 완료")
        .setColor(0x2ecc71)
        .setDescription(
          [
            `저장된 역할 수: ${count}개`,
            `저장 시각: ${nowISO()}`,
          ].join("\n")
        );

      await sendLog(guild, embed);

      return interaction.editReply({
        content: `역할 백업 완료: 총 ${count}개의 역할 정보를 저장했습니다.`,
      });
    }

    if (commandName === "삭제된역할") {
      const deleted = getDeletedRoleSnapshots(guild.id);

      if (deleted.length === 0) {
        return interaction.reply({
          content: "현재 삭제된 역할 기록이 없습니다.",
          ephemeral: true,
        });
      }

      const lines = deleted.slice(0, 20).map((r, i) => {
        return `${i + 1}. ${r.name}\n삭제시각: ${r.deletedAt || "기록 없음"}`;
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

      const roleName = interaction.options.getString("역할이름", true).trim();
      const result = await restoreSingleDeletedRole(guild, roleName);

      if (!result.ok) {
        return interaction.editReply({
          content: result.reason,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("정밀 역할 복구 완료")
        .setColor(0x3498db)
        .setDescription(
          [
            `역할명: ${result.roleName}`,
            `재지급 인원: ${result.assignedCount}명`,
            `복구 시각: ${nowISO()}`,
          ].join("\n")
        );

      await sendLog(guild, embed);

      return interaction.editReply({
        content:
          `역할 복구 완료\n` +
          `역할: ${result.roleName}\n` +
          `재지급: ${result.assignedCount}명`,
      });
    }

    if (commandName === "역할전체복구") {
      await interaction.deferReply({ ephemeral: true });

      const result = await restoreAllDeletedRoles(guild);

      const restoredText =
        result.restored.length > 0
          ? result.restored.map((r) => `- ${r.name} (${r.assignedCount}명 재지급)`).join("\n")
          : "없음";

      const skippedText =
        result.skipped.length > 0
          ? result.skipped.map((r) => `- ${r.name}: ${r.reason}`).join("\n")
          : "없음";

      const embed = new EmbedBuilder()
        .setTitle("역할 전체 복구 완료")
        .setColor(0x5865f2)
        .addFields(
          { name: "복구됨", value: restoredText.slice(0, 1024) || "없음" },
          { name: "건너뜀", value: skippedText.slice(0, 1024) || "없음" }
        )
        .setFooter({ text: `총 복구 ${result.restored.length}개 / 건너뜀 ${result.skipped.length}개` });

      await sendLog(guild, embed);

      return interaction.editReply({
        content:
          `역할 전체 복구 완료\n` +
          `복구됨: ${result.restored.length}개\n` +
          `건너뜀: ${result.skipped.length}개`,
      });
    }

    if (commandName === "역할지급") {
      await interaction.deferReply({ ephemeral: true });

      const result = await reassignRestoredRoles(guild);

      const embed = new EmbedBuilder()
        .setTitle("역할 재지급 완료")
        .setColor(0x1abc9c)
        .setDescription(
          [
            `재지급 건수: ${result.successCount}건`,
            `처리 시각: ${nowISO()}`,
          ].join("\n")
        );

      await sendLog(guild, embed);

      return interaction.editReply({
        content: `역할 재지급 완료: 총 ${result.successCount}건 처리했습니다.`,
      });
    }

    if (commandName === "테러위험대상") {
      const risk = getRiskLogData();
      const nukeList = risk.nukeCases.slice(0, 10);

      if (nukeList.length === 0) {
        return interaction.reply({
          content: "현재 기록된 테러 위험 대상이 없습니다.",
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("테러 위험 대상 목록")
        .setColor(0xff3b30)
        .setDescription(
          nukeList
            .map((x, i) =>
              [
                `**${i + 1}. ${x.tag}** (<@${x.userId}>)`,
                `사유: ${x.reason}`,
                `처리 시각: ${x.processedAt}`,
                `해제 여부: ${x.released ? "해제됨" : "격리 중"}`,
              ].join("\n")
            )
            .join("\n\n")
            .slice(0, 4096)
        );

      return interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    }

    if (commandName === "위험해제") {
      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser("대상", true);
      const member = await guild.members.fetch(user.id).catch(() => null);

      if (!member) {
        return interaction.editReply({
          content: "해당 유저를 서버에서 찾을 수 없습니다.",
        });
      }

      try {
        await member.timeout(null, "관리자 명령으로 위험 해제");
      } catch {}

      const risk = getRiskLogData();
      const targetCase = risk.nukeCases.find(
        (x) => x.userId === user.id && !x.released
      );

      let restoredCount = 0;

      if (targetCase?.removedRoles?.length) {
        for (const roleInfo of targetCase.removedRoles) {
          const role = guild.roles.cache.get(roleInfo.id);
          if (!role) continue;
          if (role.position >= guild.members.me.roles.highest.position) continue;

          try {
            await member.roles.add(role, "관리자 명령으로 위험 해제 및 역할 복원");
            restoredCount++;
            await sleep(250);
          } catch {}
        }
      }

      if (targetCase) {
        targetCase.released = true;
        targetCase.releasedAt = nowISO();
        setRiskLogData(risk);
      }

      const embed = new EmbedBuilder()
        .setTitle("위험 해제 완료")
        .setColor(0x2ecc71)
        .setDescription(
          [
            `대상: <@${user.id}>`,
            `복원된 관리 역할 수: ${restoredCount}`,
            `처리 시각: ${nowISO()}`,
          ].join("\n")
        );

      await sendLog(guild, embed);

      return interaction.editReply({
        content: `위험 해제 완료: ${user.tag}의 격리를 해제했고, 관리 역할 ${restoredCount}개를 복원했습니다.`,
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
   자동 역할 백업
========================= */
let backupInterval = null;

async function startAutoBackup() {
  if (backupInterval) clearInterval(backupInterval);

  backupInterval = setInterval(async () => {
    try {
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) return;

      const fullGuild = await guild.fetch();
      const count = await backupAllRoles(fullGuild);

      console.log(`[자동백업] 역할 ${count}개 저장 완료`);
    } catch (err) {
      console.error("[자동백업] 실패:", err);
    }
  }, AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000);
}

/* =========================
   준비 완료
========================= */
client.once("ready", async () => {
  console.log(`로그인 완료: ${client.user.tag}`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) {
      const fullGuild = await guild.fetch();
      const count = await backupAllRoles(fullGuild);
      console.log(`[시작백업] 역할 ${count}개 저장 완료`);
    }
  } catch (err) {
    console.error("[시작백업] 실패:", err);
  }

  await startAutoBackup();
});

/* =========================
   시작
========================= */
(async () => {
  try {
    if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
      throw new Error("TOKEN / CLIENT_ID / GUILD_ID 환경변수를 설정하세요.");
    }

    await registerCommands();
    await client.login(TOKEN);
  } catch (err) {
    console.error("봇 시작 실패:", err);
  }
})();
