    require("dotenv").config();
    const {
      Client, GatewayIntentBits, Partials, Events, SlashCommandBuilder, REST, Routes,
      PermissionFlagsBits, ChannelType, EmbedBuilder, AuditLogEvent,
      ButtonBuilder, ButtonStyle, ActionRowBuilder
    } = require("discord.js");
    const fs = require("node:fs");
    const path = require("node:path");
    const cron = require("node-cron");

    const TOKEN = process.env.DISCORD_TOKEN;
    const CLIENT_ID = process.env.CLIENT_ID;
    const GUILD_ID = process.env.GUILD_ID;

    // Only owners and senior leadership can reconfigure private monitoring channels.
    // Moderation Lead and Moderators retain the existing log visibility rules.
    const OWNER_IDS = [
      "1549252381458436189", // Ares
      "1548812445240262799"  // Artemis
    ];
    const STAFF_MONITOR_SETUP_ROLE_NAMES = ["Head Admin", "Senior Admins"];

    function canConfigureStaffMonitor(interaction) {
      if (OWNER_IDS.includes(interaction.user.id)) return true;
      if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

      const roles = interaction.member?.roles?.cache;
      if (!roles) return false;

      return STAFF_MONITOR_SETUP_ROLE_NAMES.some(name =>
        roles.some(role => role.name === name)
      );
    }
    const DATA_DIR = process.env.DATA_DIR || "/data";
    const CONFIG_FILE = path.join(DATA_DIR, "staff-monitor-config.json");
    const STATS_FILE = path.join(DATA_DIR, "staff-monitor-stats.json");
    const CHECKLIST_FILE = path.join(DATA_DIR, "moderation-daily-checklist.json");
    if (!TOKEN || !CLIENT_ID || !GUILD_ID) throw new Error("Set DISCORD_TOKEN, CLIENT_ID and GUILD_ID.");

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent],
      partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
    });

    let config = {};
    let stats = { day: ukDate(), actions: {} };

    function readJson(file, fallback) {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
    }
    function writeJson(file, value) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, file);
    }
    function loadData() {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      config = readJson(CONFIG_FILE, {});
      stats = readJson(STATS_FILE, {
        day: ukDate(),
        actions: {}
      });
    }
    function ukDate() {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
    }

    function safe(value, max = 900) {
      const text = String(value ?? "Not provided").replace(/```/g, "'''");
      return text.length > max ? `${text.slice(0, max - 3)}...` : text;
    }
    function embed(title, description, color = 0xC9A44C) {
      return new EmbedBuilder().setColor(color).setTitle(title)
        .setDescription(description || "No additional details.").setTimestamp();
    }
    async function sendLog(guild, channelId, messageEmbed) {
      if (!channelId) return;
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [messageEmbed], allowedMentions: { parse: [] } })
          .catch(error => console.error("[Staff Monitor] Send log failed:", error.message));
      }
    }
    function isModerator(member) {
      return !!member && !!config.roles?.moderator && member.roles.cache.has(config.roles.moderator);
    }
    async function logAction(guild, title, description, {
      executorId = null, targetId = null, reason = null, extra = null,
      moderatorAction = false, actionKey = "other", color = 0xC9A44C
    } = {}) {
      const e = embed(title, description, color);
      if (executorId) e.addFields({ name: "Staff member", value: `<@${executorId}> (\`${executorId}\`)`, inline: true });
      if (targetId) e.addFields({ name: "Target", value: `<@${targetId}> (\`${targetId}\`)`, inline: true });
      if (reason) e.addFields({ name: "Reason", value: safe(reason) });
      if (extra) e.addFields({ name: "Details", value: safe(extra) });

      await sendLog(guild, config.channels?.leadership, e);
      if (moderatorAction) await sendLog(guild, config.channels?.moderation, e);

      if (executorId && moderatorAction) {
        const today = ukDate();
        if (stats.day !== today) stats = { day: today, actions: {} };
        const key = `${executorId}:${actionKey}`;
        stats.actions[key] = (stats.actions[key] || 0) + 1;
        writeJson(STATS_FILE, stats);
      }
    }
    function actionName(action, changes = []) {
      const map = new Map([
        [AuditLogEvent.GuildUpdate, "Server settings updated"],
        [AuditLogEvent.MemberBanAdd, "Member banned"],
        [AuditLogEvent.MemberBanRemove, "Member unbanned"],
        [AuditLogEvent.MemberKick, "Member kicked"],
        [AuditLogEvent.MemberUpdate, "Member updated"],
        [AuditLogEvent.MemberRoleUpdate, "Member roles changed"],
        [AuditLogEvent.MessageDelete, "Message deleted"],
        [AuditLogEvent.MessageBulkDelete, "Messages bulk deleted"],
        [AuditLogEvent.ChannelCreate, "Channel created"],
        [AuditLogEvent.ChannelDelete, "Channel deleted"],
        [AuditLogEvent.ChannelUpdate, "Channel updated"],
        [AuditLogEvent.ChannelOverwriteCreate, "Channel permission overwrite created"],
        [AuditLogEvent.ChannelOverwriteUpdate, "Channel permissions changed"],
        [AuditLogEvent.ChannelOverwriteDelete, "Channel permission overwrite deleted"],
        [AuditLogEvent.RoleCreate, "Role created"],
        [AuditLogEvent.RoleDelete, "Role deleted"],
        [AuditLogEvent.RoleUpdate, "Role updated"],
        [AuditLogEvent.WebhookCreate, "Webhook created"],
        [AuditLogEvent.WebhookDelete, "Webhook deleted"],
        [AuditLogEvent.WebhookUpdate, "Webhook updated"],
        [AuditLogEvent.ThreadCreate, "Thread created"],
        [AuditLogEvent.ThreadDelete, "Thread deleted"],
        [AuditLogEvent.ThreadUpdate, "Thread updated"],
        [AuditLogEvent.InviteCreate, "Invite created"],
        [AuditLogEvent.InviteDelete, "Invite deleted"]
      ]);

      if (action === AuditLogEvent.ChannelUpdate) {
        const nameChange = changes.find(c => c.key === "name");
        if (nameChange) return "Channel renamed";
      }
      return map.get(action) || `Other Discord audit action (${action})`;
    }

    function readableValue(value) {
      if (value === null || value === undefined) return "none";
      if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
      if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }

    function describeAuditChanges(entry) {
      const changes = entry.changes || [];
      if (!changes.length) return `Audit entry ID: ${entry.id}`;

      const labels = {
        name: "Name",
        topic: "Topic",
        nsfw: "Age restricted",
        rate_limit_per_user: "Slowmode (seconds)",
        bitrate: "Bitrate",
        user_limit: "User limit",
        parent_id: "Category ID",
        position: "Position",
        permission_overwrites: "Permission overwrites",
        allow: "Permissions allowed",
        deny: "Permissions denied",
        color: "Role colour",
        hoist: "Displayed separately",
        mentionable: "Mentionable",
        permissions: "Role permissions",
        nick: "Nickname",
        communication_disabled_until: "Timeout until",
        mute: "Server muted",
        deaf: "Server deafened"
      };

      return changes.map(change => {
        const label = labels[change.key] || change.key.replace(/_/g, " ");
        return `**${label}:** ${readableValue(change.old)} → ${readableValue(change.new)}`;
      }).join("\n");
    }

    function actionKey(action) {
      if ([AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberBanRemove].includes(action)) return "ban";
      if (action === AuditLogEvent.MemberKick) return "kick";
      if (action === AuditLogEvent.MemberUpdate) return "member_update";
      if (action === AuditLogEvent.MemberRoleUpdate) return "role_change";
      if ([AuditLogEvent.MessageDelete, AuditLogEvent.MessageBulkDelete].includes(action)) return "message_delete";
      return "server_change";
    }

    client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
      try {
        if (guild.id !== GUILD_ID) return;
        const executorId = entry.executorId || entry.executor?.id;
        if (!executorId) return;
        const member = await guild.members.fetch(executorId).catch(() => null);
        const isMod = isModerator(member);
        const changes = entry.changes || [];
        const targetId = entry.targetId || null;
        const target = targetId
          ? guild.channels.cache.get(targetId)?.name
            || guild.roles.cache.get(targetId)?.name
            || guild.members.cache.get(targetId)?.user?.tag
            || null
          : null;
        const title = `📋 ${actionName(entry.action, changes)}`;
        const targetLine = target ? `**Affected item:** ${target}\n` : "";
        await logAction(guild, title,
          `${targetLine}A Discord audit-log action was recorded.`, {
            executorId, targetId, reason: entry.reason,
            extra: describeAuditChanges(entry),
            moderatorAction: isMod, actionKey: actionKey(entry.action),
            color: isMod ? 0xE67E22 : 0xC9A44C
          });
      } catch (error) { console.error("[Staff Monitor] Audit event:", error); }
    });

    // These events provide context, but Discord may not identify the staff actor for message edits/deletions.
    client.on(Events.MessageDelete, async message => {
      if (!message.guild || message.guild.id !== GUILD_ID || message.author?.bot) return;
      await logAction(message.guild, "🗑️ Message deleted", "A message deletion was detected.", {
        targetId: message.author?.id,
        extra: `Channel: <#${message.channelId}>. Message ID: ${message.id}. Actor may not be identifiable.`,
        color: 0xD64545
      });
    });
    client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      if (!newMessage.guild || newMessage.guild.id !== GUILD_ID || newMessage.author?.bot) return;
      if (oldMessage.partial || newMessage.partial || oldMessage.content === newMessage.content) return;
      await logAction(newMessage.guild, "✏️ Message edited",
        "A message edit was detected. Message content is not stored.", {
          targetId: newMessage.author?.id,
          extra: `Channel: <#${newMessage.channelId}>. Message ID: ${newMessage.id}. Actor is the message author.`,
          color: 0x3498DB
        });
    });
    client.on(Events.GuildMemberAdd, async member => {
      if (member.guild.id !== GUILD_ID || member.user.bot) return;
      await logAction(member.guild, "📥 Member joined", `${member.user.tag} joined the server.`, { targetId: member.id });
    });
    client.on(Events.GuildMemberRemove, async member => {
      if (member.guild.id !== GUILD_ID || member.user.bot) return;
      await logAction(member.guild, "📤 Member left",
        `${member.user.tag} left the server. A matching audit entry may identify a kick or ban.`,
        { targetId: member.id });
    });
    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
      try {
        if (newMember.guild.id !== GUILD_ID) return;
        const before = oldMember.roles.cache.map(r => r.id);
        const after = newMember.roles.cache.map(r => r.id);
        const added = after.filter(id => !before.includes(id));
        const removed = before.filter(id => !after.includes(id));
        if (!added.length && !removed.length && oldMember.nickname === newMember.nickname) return;
        const detail = [
          added.length ? `Roles added: ${added.map(id => `<@&${id}>`).join(", ")}` : "",
          removed.length ? `Roles removed: ${removed.map(id => `<@&${id}>`).join(", ")}` : "",
          oldMember.nickname !== newMember.nickname ? `Nickname: ${oldMember.nickname || "none"} → ${newMember.nickname || "none"}` : ""
        ].filter(Boolean).join("\n");
        await logAction(newMember.guild, "👤 Member roles or nickname changed",
          "A member update was detected. The actor is identified if Discord provides a matching audit-log entry.",
          { targetId: newMember.id, extra: detail });
      } catch (error) { console.error("[Staff Monitor] Member update:", error); }
    });

    const setupCommand = new SlashCommandBuilder()
      .setName("setup-staff-monitor")
      .setDescription("Create or update the private staff monitoring channels.")
      .setDefaultMemberPermissions(null)
      .addUserOption(o => o.setName("ares").setDescription("Ares account").setRequired(true))
      .addUserOption(o => o.setName("artemis").setDescription("Artemis account").setRequired(true))
      .addRoleOption(o => o.setName("head_admin").setDescription("Head Admin role").setRequired(true))
      .addRoleOption(o => o.setName("senior_admin").setDescription("Senior Admin role").setRequired(true))
      .addRoleOption(o => o.setName("moderation_lead").setDescription("Moderation Lead role").setRequired(true))
      .addRoleOption(o => o.setName("moderator").setDescription("Moderator role").setRequired(true));

    const MODERATION_CHECKLIST = [
      "Review all open member reports, tickets and complaints.",
      "Check scammer reports and suspicious player tags; pass confirmed concerns through the approved process.",
      "Monitor public chats for rule-breaking, harassment, scams and disruptive behaviour.",
      "Follow up on warnings, timeouts and unresolved moderation cases.",
      "Check verification concerns and make sure suspicious accounts are escalated.",
      "Ensure moderation actions have clear reasons and are recorded in the correct logs.",
      "Check that moderators are covering their duties and that unattended areas are followed up.",
      "Escalate serious incidents, repeat offenders and uncertain decisions to senior leadership.",
      "Before finishing, review outstanding reports and hand over anything that still needs attention."
    ];

    function readChecklist() {
      const saved = readJson(CHECKLIST_FILE, {});
      const today = ukDate();
      if (saved.date !== today) return { date: today, completed: {} };
      return { date: today, completed: saved.completed || {} };
    }

    function saveChecklist(data) {
      writeJson(CHECKLIST_FILE, data);
    }

    function canUseModerationChecklist(interaction) {
      if (OWNER_IDS.includes(interaction.user.id)) return true;
      if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
      const roles = interaction.member?.roles?.cache;
      if (!roles) return false;
      const allowedIds = [config.roles?.headAdmin, config.roles?.seniorAdmin, config.roles?.moderationLead]
        .filter(Boolean);
      if (allowedIds.some(id => roles.has(id))) return true;
      return ["Head Admin", "Senior Admins", "Moderation Lead"].some(name =>
        roles.some(role => role.name === name)
      );
    }

    function buildChecklistMessage(data) {
      const completedCount = MODERATION_CHECKLIST.filter((_, i) => data.completed[i]).length;
      const lines = MODERATION_CHECKLIST.map((item, i) => {
        const markedBy = data.completed[i] && data.completedBy?.[i]
          ? `\n   Completed by <@${data.completedBy[i]}>`
          : "";
        return `${data.completed[i] ? "☑️" : "⬜"} **${i + 1}.** ${item}${markedBy}`;
      });
      const description = lines.join("\n\n");
      const message = embed("🛡️ Daily Moderation Team Checklist", description, 0xC9A44C);
      message.addFields(
        { name: "Date (UK)", value: data.date, inline: true },
        { name: "Progress", value: `${completedCount}/${MODERATION_CHECKLIST.length} completed`, inline: true },
        { name: "Reminder", value: "Only tick an item once the task has genuinely been completed. Escalate serious issues to senior leadership." }
      );
      return message;
    }

    function buildChecklistRows(data) {
      const rows = [];
      for (let start = 0; start < MODERATION_CHECKLIST.length; start += 5) {
        const row = new ActionRowBuilder();
        for (let i = start; i < Math.min(start + 5, MODERATION_CHECKLIST.length); i++) {
          row.addComponents(new ButtonBuilder()
            .setCustomId(`modcheck:${i}`)
            .setLabel(`${data.completed[i] ? "✓ " : "□ "}${i + 1}`)
            .setStyle(data.completed[i] ? ButtonStyle.Success : ButtonStyle.Secondary));
        }
        rows.push(row);
      }
      return rows;
    }

    const moderationChecklistCommand = new SlashCommandBuilder()
      .setName("moderation-checklist")
      .setDescription("Open the daily checklist for the Moderation team.")
      .setDefaultMemberPermissions(null);

    async function setupChannel(guild, name, allowedIds) {
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ] },
        ...[...new Set(allowedIds)].map(id => ({
          id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads]
        }))
      ];
      let channel = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText);
      if (!channel) {
        channel = await guild.channels.create({
          name, type: ChannelType.GuildText,
          topic: "Private staff monitoring channel. Automatically generated logs.",
          permissionOverwrites: overwrites,
          reason: "Set up The Outcasts staff monitoring"
        });
      } else {
        await channel.permissionOverwrites.set(overwrites, "Update staff monitoring permissions");
      }
      return channel;
    }

    client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.inGuild() || interaction.guildId !== GUILD_ID) return;

      if (interaction.isChatInputCommand() && interaction.commandName === "moderation-checklist") {
        if (!canUseModerationChecklist(interaction)) {
          return interaction.reply({
            content: "⛔ This checklist is for the Moderation Lead and senior leadership only.",
            ephemeral: true
          });
        }
        const data = readChecklist();
        saveChecklist(data);
        return interaction.reply({
          embeds: [buildChecklistMessage(data)],
          components: buildChecklistRows(data),
          ephemeral: true
        });
      }

      if (interaction.isButton() && interaction.customId.startsWith("modcheck:")) {
        if (!canUseModerationChecklist(interaction)) {
          return interaction.reply({ content: "⛔ You cannot update this moderation checklist.", ephemeral: true });
        }
        const index = Number(interaction.customId.split(":")[1]);
        if (!Number.isInteger(index) || index < 0 || index >= MODERATION_CHECKLIST.length) {
          return interaction.reply({ content: "That checklist item is invalid.", ephemeral: true });
        }
        const data = readChecklist();
        data.completed[index] = !data.completed[index];
        if (data.completed[index]) data.completedBy = data.completedBy || {};
        if (data.completed[index]) data.completedBy[index] = interaction.user.id;
        else if (data.completedBy) delete data.completedBy[index];
        saveChecklist(data);
        await interaction.update({
          embeds: [buildChecklistMessage(data)],
          components: buildChecklistRows(data)
        });
        const guild = interaction.guild;
        const state = data.completed[index] ? "completed" : "reopened";
        const checklistLog = embed("🛡️ Moderation checklist updated",
          `<@${interaction.user.id}> ${state} item ${index + 1}: ${MODERATION_CHECKLIST[index]}\n\nDaily checklist date: ${data.date}`,
          data.completed[index] ? 0x2ECC71 : 0xE67E22);
        checklistLog.addFields({ name: "Updated by", value: `<@${interaction.user.id}>` });
        await sendLog(guild, config.channels?.moderation, checklistLog);
        await sendLog(guild, config.channels?.leadership, checklistLog);
        return;
      }

      if (!interaction.isChatInputCommand() || interaction.commandName !== "setup-staff-monitor") return;
      if (!canConfigureStaffMonitor(interaction)) {
        return interaction.reply({
          content: "⛔ Only Ares, Artemis, server administrators, Head Admins or Senior Admins can configure the private staff monitoring channels.",
          ephemeral: true
        });
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const ares = interaction.options.getUser("ares", true);
        const artemis = interaction.options.getUser("artemis", true);
        const head = interaction.options.getRole("head_admin", true);
        const senior = interaction.options.getRole("senior_admin", true);
        const lead = interaction.options.getRole("moderation_lead", true);
        const moderator = interaction.options.getRole("moderator", true);

        const expectedRoles = [
          [head, "Head Admin"],
          [senior, "Senior Admins"],
          [lead, "Moderation Lead"],
          [moderator, "Moderators"]
        ];
        const incorrectRole = expectedRoles.find(([role, expectedName]) => role.name !== expectedName);
        if (incorrectRole) {
          return interaction.editReply(
            `❌ Please select the exact **${incorrectRole[1]}** role. You selected **${incorrectRole[0].name}**.`
          );
        }

        const leadershipIds = [ares.id, artemis.id, head.id, senior.id];
        const moderationIds = [...leadershipIds, lead.id];

        const leadership = await setupChannel(interaction.guild, "leadership-activity-log", leadershipIds);
        const moderation = await setupChannel(interaction.guild, "moderation-performance-log", moderationIds);
        config = {
          guildId: interaction.guildId,
          roles: { headAdmin: head.id, seniorAdmin: senior.id, moderationLead: lead.id, moderator: moderator.id },
          channels: { leadership: leadership.id, moderation: moderation.id },
          configuredAt: new Date().toISOString(),
          configuredBy: interaction.user.id
        };
        writeJson(CONFIG_FILE, config);

        await interaction.editReply(
          `✅ Monitoring configured.\n\n**Leadership Activity Log:** ${leadership}\nVisible only to Ares, Artemis, Head Admins and Senior Admins.\n\n` +
          `**Moderation Performance Log:** ${moderation}\nVisible to Ares, Artemis, Head Admins, Senior Admins and the Moderation Lead. Moderators cannot view it.`
        );
        await logAction(interaction.guild, "🛡️ Staff monitoring configured",
          `Configured by <@${interaction.user.id}>.`, { executorId: interaction.user.id });
      } catch (error) {
        console.error("[Staff Monitor] Setup failed:", error);
        await interaction.editReply(`❌ Setup failed: ${safe(error.message)}. Check Manage Channels and View Audit Log permissions.`);
      }
    });

    async function dailySummary() {
      if (!config.guildId || !config.channels?.moderation) return;
      const guild = await client.guilds.fetch(config.guildId).catch(() => null);
      if (!guild) return;
      const lines = Object.entries(stats.actions || {}).map(([key, count]) => {
        const [userId, kind] = key.split(":");
        return `<@${userId}> — **${count}** ${kind.replace(/_/g, " ")} action(s)`;
      });
      const summary = embed("📊 Daily Moderator Activity Summary",
        lines.length ? lines.join("\n") : "No moderator-role audit actions were recorded today.", 0x5865F2);
      summary.addFields({ name: "Date", value: stats.day || "Today" });
      await sendLog(guild, config.channels.moderation, summary);
      await sendLog(guild, config.channels.leadership, summary);
      stats = { day: ukDate(), actions: {} };
      writeJson(STATS_FILE, stats);
    }

    client.once(Events.ClientReady, async ready => {
      console.log(`[Staff Monitor] Online as ${ready.user.tag}`);
      try {
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [setupCommand.toJSON(), moderationChecklistCommand.toJSON()] });
        console.log("[Staff Monitor] /setup-staff-monitor and /moderation-checklist registered.");
      } catch (error) { console.error("[Staff Monitor] Command registration failed:", error); }
      cron.schedule("0 0 * * *", dailySummary, { timezone: "Europe/London" });
      if (!config.guildId) console.log("[Staff Monitor] Run /setup-staff-monitor in the server.");
    });

    loadData();
    client.login(TOKEN);
