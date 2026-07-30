const fs = require('node:fs');
const path = require('node:path');
const Discord = require('discord.js');
const { request } = require('undici');
const config = require('./config.json');

const token = config.TOKEN || config.token || process.env.DISCORD_TOKEN || process.env.TOKEN;
const dataPath = path.join(__dirname, 'data.json');
const client = new Discord.Client({ intents: [Discord.GatewayIntentBits.Guilds] });
const cache = new Map();
const buttonOwners = new Map();
const onlineSessions = new Map();
const state = loadState();

function loadState() {
    try {
        const raw = fs.readFileSync(dataPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            guilds: parsed.guilds || {},
            pending: parsed.pending || {},
            links: parsed.links || {}
        };
    } catch {
        return {
            guilds: {},
            pending: {},
            links: {}
        };
    }
}

function saveState() {
    fs.writeFileSync(dataPath, JSON.stringify(state, null, 2), 'utf8');
}

function getGuildState(guildId) {
    if (!state.guilds[guildId]) {
        state.guilds[guildId] = {};
    }

    return state.guilds[guildId];
}

function getEmbedEmoji(title = '', color = 0x2b90ff) {
    const lowerTitle = String(title).toLowerCase();

    if (lowerTitle.includes('complete') || lowerTitle.includes('sent') || lowerTitle.includes('enabled') || lowerTitle.includes('set') || lowerTitle.includes('assigned') || lowerTitle.includes('linked') || lowerTitle.includes('joined')) {
        return '✅';
    }

    if (lowerTitle.includes('canceled') || lowerTitle.includes('disabled') || lowerTitle.includes('cleared')) {
        return '⚠️';
    }

    if (lowerTitle.includes('failed') || lowerTitle.includes('error') || lowerTitle.includes('invalid') || lowerTitle.includes('could not') || lowerTitle.includes('already') || lowerTitle.includes('no ')) {
        return '❌';
    }

    if (lowerTitle.includes('config')) {
        return '⚙️';
    }

    if (lowerTitle.includes('group')) {
        return '👥';
    }

    if (lowerTitle.includes('lookup') || lowerTitle.includes('found')) {
        return '🔎';
    }

    if (lowerTitle.includes('profile')) {
        return '👤';
    }

    if (lowerTitle.includes('online')) {
        return '🟢';
    }

    if (lowerTitle.includes('verification')) {
        return color === 0xff4d4d ? '❌' : '🔐';
    }

    if (lowerTitle.includes('link')) {
        return '🔗';
    }

    if (lowerTitle.includes('status')) {
        return 'ℹ️';
    }

    return '💬';
}

function makeEmbed({ title, description, color = 0x2b90ff, fields = [], footer } = {}) {
    const embed = new Discord.EmbedBuilder().setColor(color);

    if (title) {
        const emoji = getEmbedEmoji(title, color);
        embed.setTitle(`${emoji} ${title}`);
    }

    if (description) {
        embed.setDescription(description);
    }

    if (fields.length) {
        embed.addFields(fields);
    }

    if (footer) {
        embed.setFooter({ text: footer });
    }

    return embed;
}

function makeVerificationPanel(guild, guildState) {
    const lines = [
        'Link your Discord account to your VRChat account by verifying ownership of your VRChat profile.',
        '',
        '1. Click **Start Verification**.',
        '2. Paste your VRChat profile link.',
        '3. Add the generated 6-character code to your VRChat bio.',
        '4. Press **Check Verification**.'
    ];

    if (guildState?.groupId) {
        lines.push('', 'Verified users will also be invited to the linked VRChat group.');
    }

    return makeEmbed({
        title: 'VRChat Account Verification',
        description: lines.join('\n'),
        footer: guild ? `Configured for ${guild.name}` : undefined
    });
}

function makeResultEmbed(user) {
    const avatar = user.userIcon || user.currentAvatarThumbnailImageUrl;

    return makeEmbed({
        title: 'VRChat Profile Found',
        description: `Found **${user.displayName}**. Confirm to generate a verification code.`
    }).setThumbnail(avatar || null);
}

function makeStatusEmbed(discordUserId, guildId) {
    const linked = state.links[discordUserId];
    const pending = state.pending[discordUserId];
    const guildState = guildId ? state.guilds[guildId] : null;

    if (!linked && !pending) {
        const fields = [];

        if (guildState?.groupId) {
            fields.push({ name: 'Linked VRChat Group', value: guildState.groupName || 'Configured', inline: false });
        }

        return makeEmbed({
            title: 'VRChat Link Status',
            description: 'No VRChat account is linked to this Discord account yet.',
            fields
        });
    }

    const fields = [];

    if (linked) {
        fields.push(
            { name: 'Linked Account', value: linked.displayName || 'Unknown', inline: true },
            { name: 'Status', value: 'Linked and ready', inline: true }
        );
    }

    if (pending) {
        fields.push(
            { name: 'Pending Verification', value: pending.vrchatDisplayName || 'In progress', inline: true },
            { name: 'Verification Code', value: `\`${pending.code}\``, inline: true }
        );
    }

    if (guildState?.groupId) {
        fields.push({ name: 'Linked VRChat Group', value: guildState.groupName || 'Configured', inline: false });
    }

    return makeEmbed({
        title: 'VRChat Link Status',
        description: 'Your current Discord and VRChat link state.',
        fields
    });
}

function truncateText(text, maxLength = 900) {
    const value = String(text || '').trim();

    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatTrustLevel(tags = []) {
    const tagList = Array.isArray(tags) ? tags : [];
    const levels = [
        ['system_trust_veteran', '🏅 Veteran'],
        ['system_trust_trusted', '🛡️ Trusted'],
        ['system_trust_known', '🌟 Known'],
        ['system_trust_basic', '👤 New User'],
        ['visitor', '👋 Visitor']
    ];

    for (const [tag, label] of levels) {
        if (tagList.includes(tag)) {
            return label;
        }
    }

    return 'Unknown';
}

function formatVrchatStatus(user) {
    const status = String(user?.status || 'offline').replace(/[_-]+/g, ' ').trim();
    const statusText = status.charAt(0).toUpperCase() + status.slice(1);
    const customStatus = String(user?.statusDescription || '').trim();

    if (!customStatus) {
        return statusText;
    }

    return `${statusText}\n${customStatus}`;
}

function makeVerifiedUserProfileEmbed(discordUser, vrchatUser) {
    const avatar = vrchatUser.userIcon || vrchatUser.currentAvatarThumbnailImageUrl || vrchatUser.profilePicOverride || null;
    const profileUrl = `https://vrchat.com/home/user/${vrchatUser.id}`;
    const bio = truncateText(vrchatUser.bio || 'No bio set.');
    const vrchatName = vrchatUser.displayName || vrchatUser.username || 'Unknown';

    return makeEmbed({
        title: 'VRChat Profile',
        description: `Verified profile for ${discordUser}.`,
        fields: [
            { name: 'Discord User', value: `${discordUser}`, inline: true },
            { name: 'VRChat Username', value: `[${vrchatName}](${profileUrl})`, inline: true },
            { name: 'Trust Level', value: formatTrustLevel(vrchatUser.tags), inline: true },
            { name: 'Age Verified', value: isAgeVerified(vrchatUser) ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Status', value: formatVrchatStatus(vrchatUser), inline: false },
            { name: 'Bio', value: bio, inline: false },
            { name: 'Profile Link', value: `[Open Profile](${profileUrl})`, inline: false }
        ]
    }).setThumbnail(avatar || null);
}

function formatOnlineEntry(entry) {
    const profileUrl = `https://vrchat.com/home/user/${entry.vrchatUser.id}`;
    const name = entry.vrchatUser.displayName || entry.vrchatUser.username || 'Unknown';
    const status = String(entry.vrchatUser.status || '').replace(/[_-]+/g, ' ').trim().toLowerCase() || 'active';

    return `🟢 ${entry.memberMention} [${name}](${profileUrl}) - ${status}`;
}

function chunkOnlineEntries(entries, limit = 3900) {
    const pages = [];
    let currentEntries = [];
    let currentLength = 0;

    for (const entry of entries) {
        const line = formatOnlineEntry(entry);
        const extraLength = currentEntries.length === 0 ? line.length : line.length + 1;

        if (currentEntries.length > 0 && currentLength + extraLength > limit) {
            pages.push(currentEntries);
            currentEntries = [entry];
            currentLength = line.length;
            continue;
        }

        currentEntries.push(entry);
        currentLength += extraLength;
    }

    if (currentEntries.length > 0) {
        pages.push(currentEntries);
    }

    return pages;
}

function makeOnlineUsersEmbed(guild, entries, pageIndex = 0, totalPages = 1) {
    const firstAvatar = entries[0]?.vrchatUser?.userIcon || entries[0]?.vrchatUser?.currentAvatarThumbnailImageUrl || entries[0]?.vrchatUser?.profilePicOverride || null;
    const lines = entries.map(formatOnlineEntry);

    return makeEmbed({
        title: 'VRChat Online',
        description: lines.join('\n'),
        footer: guild ? `${entries.length} verified user${entries.length === 1 ? '' : 's'} online${totalPages > 1 ? ` • Page ${pageIndex + 1}/${totalPages}` : ''}` : undefined
    }).setThumbnail(firstAvatar || null);
}

function makeOnlineControls(pageIndex = 0, totalPages = 1) {
    const row = new Discord.ActionRowBuilder();

    if (totalPages > 1) {
        row.addComponents(
            new Discord.ButtonBuilder()
                .setCustomId('vrchat-online-prev')
                .setLabel('Previous')
                .setStyle(Discord.ButtonStyle.Secondary)
                .setDisabled(pageIndex <= 0),
            new Discord.ButtonBuilder()
                .setCustomId('vrchat-online-next')
                .setLabel('Next')
                .setStyle(Discord.ButtonStyle.Secondary)
                .setDisabled(pageIndex >= totalPages - 1)
        );
    }

    row.addComponents(
        new Discord.ButtonBuilder()
            .setCustomId('vrchat-online-refresh')
            .setLabel('Refresh')
            .setEmoji('🔁')
            .setStyle(Discord.ButtonStyle.Primary)
    );

    return [row];
}

async function buildOnlineView(interaction, pageIndex = 0) {
    const members = await getOnlineVrchatMembers(interaction);
    const pages = chunkOnlineEntries(members);

    if (pages.length === 0) {
        return {
            embeds: [makeEmbed({
                title: 'VRChat Online',
                description: 'No verified members are currently online on VRChat.',
                color: 0xffcc4d
            })],
            components: makeOnlineControls()
        };
    }

    const safePageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
    onlineSessions.set(interaction.message?.id || interaction.id, {
        pageIndex: safePageIndex,
        pageCount: pages.length
    });

    return {
        embeds: [makeOnlineUsersEmbed(interaction.guild, pages[safePageIndex], safePageIndex, pages.length)],
        components: makeOnlineControls(safePageIndex, pages.length)
    };
}

async function getOnlineVrchatMembers(interaction) {
    if (!interaction.guild) {
        return [];
    }

    const linkedEntries = Object.values(state.links);
    const results = [];

    for (const link of linkedEntries) {
        const member = await interaction.guild.members.fetch(link.discordUserId).catch(() => null);
        if (!member || member.user.bot) {
            continue;
        }

        const vrchatUser = await fetchVrchatUserById(link.vrchatUserId);
        if (!vrchatUser) {
            continue;
        }

        const status = String(vrchatUser.status || '').toLowerCase();
        if (!['active', 'ask me', 'join me', 'do not disturb'].includes(status)) {
            continue;
        }

        results.push({
            memberMention: member.toString(),
            memberName: member.displayName || member.user.username,
            vrchatUser
        });
    }

    results.sort((left, right) => (left.memberName || '').localeCompare(right.memberName || ''));
    return results;
}

function makeConfigStatusEmbed(guild, guildState) {
    const fields = [
        { name: 'Link Role', value: guildState.linkRoleId ? `<@&${guildState.linkRoleId}>` : 'Not set', inline: false },
        { name: 'Nickname Mode', value: formatNicknameMode(guildState.nicknameMode), inline: false },
        { name: 'Age Gate', value: guildState.ageGateEnabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Age Gate Role', value: guildState.ageGateRoleId ? `<@&${guildState.ageGateRoleId}>` : 'Follows link role', inline: true },
        { name: 'Age Gate Fail Action', value: guildState.ageGateFailAction || 'none', inline: true },
        { name: 'Linked VRChat Group', value: guildState.groupId ? guildState.groupName || 'Configured' : 'Not set', inline: false }
    ];

    return makeEmbed({
        title: 'VRChat Config',
        description: 'Server configuration for VRChat verification and role assignment.',
        fields,
        footer: guild ? `Configured for ${guild.name}` : undefined
    });
}

function makeGradeEmbed(user) {
    const avatar = user.userIcon || user.currentAvatarThumbnailImageUrl;

    return makeEmbed({
        title: 'VRChat User Lookup',
        description: `Found **${user.displayName}**`
    }).setThumbnail(avatar || null);
}

function makeLinkButtons() {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId('vrchat-link-start')
            .setLabel('Start Verification')
            .setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder()
            .setCustomId('vrchat-link-check')
            .setLabel('Check Verification')
            .setStyle(Discord.ButtonStyle.Success)
    );
}

function makeUnlinkButton() {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId('vrchat-link-unlink')
            .setLabel('Unlink')
            .setStyle(Discord.ButtonStyle.Danger)
    );
}

function getOnlineSession(messageId) {
    return onlineSessions.get(messageId) || { pageIndex: 0, pageCount: 1 };
}

function registerButtonOwner(messageId, userId) {
    if (messageId) {
        buttonOwners.set(messageId, userId);
    }
}

function isButtonOwner(interaction) {
    const ownerId = buttonOwners.get(interaction.message.id);
    return !ownerId || ownerId === interaction.user.id;
}

async function rejectNotYourButton(interaction) {
    return interaction.reply({
        ephemeral: true,
        embeds: [makeEmbed({
            title: 'VRChat Link',
            description: 'This isnt your button',
            color: 0xff4d4d
        })]
    });
}

function makeGradeButtons() {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId('grade-confirm')
            .setLabel('Confirm')
            .setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder()
            .setCustomId('grade-next')
            .setLabel('Next')
            .setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder()
            .setCustomId('grade-cancel')
            .setLabel('Cancel')
            .setStyle(Discord.ButtonStyle.Danger)
    );
}

function generateVerificationCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';

    for (let index = 0; index < 6; index += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return code;
}

function extractProfileIdentifier(input) {
    const value = input.trim();
    const urlMatch = value.match(/(?:https?:\/\/)?(?:www\.)?(?:vrchat\.com|vrchat\.community)\/home\/user\/([^/?#]+)/i);

    if (urlMatch) {
        return decodeURIComponent(urlMatch[1]);
    }

    if (/^usr_[A-Za-z0-9-]+$/i.test(value)) {
        return value;
    }

    return null;
}

function extractGroupIdentifier(input) {
    const value = input.trim();
    const match = value.match(/grp_[A-Za-z0-9-]+/i);

    return match ? match[0] : null;
}

function isAgeVerified(user) {
    return user?.ageVerified === true || String(user?.ageVerificationStatus || '').toLowerCase() === 'verified';
}

function formatNicknameMode(mode) {
    switch (mode) {
        case 'username-paren':
            return '{username} ({VRChat Username})';
        case 'username-dash':
            return '{username} - {VRChat Username}';
        case 'vrchat-only':
            return 'Full replacement with the VRChat username';
        default:
            return 'Disabled';
    }
}

function buildNicknameForMode(member, vrchatUser, mode) {
    const discordUsername = member?.user?.username || 'Unknown';
    const vrchatName = vrchatUser?.displayName || vrchatUser?.username || 'Unknown';

    switch (mode) {
        case 'username-paren':
            return `${discordUsername} (${vrchatName})`;
        case 'username-dash':
            return `${discordUsername} - ${vrchatName}`;
        case 'vrchat-only':
            return vrchatName;
        default:
            return null;
    }
}

function resolveRoleLabel(guild, roleId) {
    if (!roleId) {
        return 'Not set';
    }

    const role = guild?.roles?.cache?.get(roleId);
    return role ? `<@&${role.id}>` : roleId;
}

async function fetchGuildMember(interaction) {
    if (!interaction.guild) {
        return null;
    }

    if (interaction.member && typeof interaction.member.roles?.add === 'function') {
        return interaction.member;
    }

    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function assignRolesToMember(interaction, roleIds) {
    const uniqueRoleIds = [...new Set(roleIds.filter(Boolean))];

    if (uniqueRoleIds.length === 0) {
        return { ok: true, message: 'No Discord roles were configured.' };
    }

    const member = await fetchGuildMember(interaction);
    if (!member) {
        return { ok: false, message: 'Could not fetch the guild member.' };
    }

    const me = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe().catch(() => interaction.guild?.members?.me);
    if (!me || !me.permissions.has(Discord.PermissionFlagsBits.ManageRoles)) {
        return { ok: false, message: 'The bot does not have permission to manage roles.' };
    }

    const assignableRoleIds = uniqueRoleIds.filter(roleId => {
        const role = interaction.guild.roles.cache.get(roleId);
        return role && me.roles.highest.position > role.position;
    });

    if (assignableRoleIds.length === 0) {
        return { ok: false, message: 'No configured roles are assignable because of role hierarchy.' };
    }

    try {
        await member.roles.add(assignableRoleIds, 'VRChat verification linking');
        return { ok: true, message: `Assigned ${assignableRoleIds.length} role(s).` };
    } catch (error) {
        console.error(error);
        return { ok: false, message: 'Failed to assign one or more Discord roles.' };
    }
}

async function applyAgeGateFailure(interaction, guildState, user) {
    const ageStatus = user?.ageVerificationStatus || (user?.ageVerified ? 'verified' : 'not verified');
    const action = guildState.ageGateFailAction || 'none';
    const failureMessage = `VRChat age verification failed (${ageStatus}).`;

    await interaction.reply({
        ephemeral: true,
        embeds: [makeEmbed({
            title: 'VRChat Verification',
            description: action === 'none'
                ? failureMessage
                : `${failureMessage} Discord action: **${action}**.`,
            color: 0xff4d4d
        })]
    });

    if (!interaction.guild || action === 'none') {
        return;
    }

    const member = await fetchGuildMember(interaction);
    if (!member) {
        return;
    }

    if (action === 'kick') {
        await member.kick('VRChat age verification failed').catch(console.error);
        return;
    }

    if (action === 'ban') {
        await interaction.guild.members.ban(member.user.id, { reason: 'VRChat age verification failed' }).catch(console.error);
    }
}

async function sendGroupInviteIfConfigured(guildState, user) {
    if (!guildState?.groupId) {
        return null;
    }

    const inviteResult = await inviteUserToGroup(guildState.groupId, user.id);
    const inviteMessage = String(inviteResult.json?.error?.message || inviteResult.json?.message || '');

    if (inviteResult.response.statusCode >= 200 && inviteResult.response.statusCode < 300) {
        return 'Group invite sent.';
    }

    if (inviteMessage.toLowerCase().includes('already')) {
        return 'User is already in the linked group.';
    }

    return `Could not send the group invite: ${inviteMessage || 'please try again later.'}`;
}

async function upsertVerificationPanelForGuild(interaction, guildState) {
    if (!guildState.verificationChannelId || !interaction.guild) {
        return;
    }

    const channel = await interaction.guild.channels.fetch(guildState.verificationChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
        await postVerificationPanel(channel, interaction.guild).catch(console.error);
    }
}

function vrchatHeaders() {
    return {
        cookie: `auth=${config.auth}; twoFactorAuth=${config.twofa}`,
        'user-agent': 'VRifyBot/1.0.0 (+https://github.com/Ashrilys/VRChatAPI-on-DiscordBot; contact=GitHub issues)'
    };
}

async function vrchatRequest(url) {
    return request(url, { headers: vrchatHeaders() });
}

async function vrchatJson(url, options = {}) {
    const { headers: extraHeaders, ...requestOptions } = options;
    const response = await request(url, {
        ...requestOptions,
        headers: {
            ...vrchatHeaders(),
            ...(extraHeaders || {})
        }
    });

    let json = null;
    try {
        json = await response.body.json();
    } catch {
        json = null;
    }

    return { response, json };
}

async function fetchGroup(groupId) {
    const { response, json } = await vrchatJson(`https://api.vrchat.cloud/api/1/groups/${encodeURIComponent(groupId)}`);

    if (response.statusCode !== 200 || !json || !json.id) {
        return null;
    }

    return json;
}

async function joinGroup(groupId) {
    return vrchatJson(`https://api.vrchat.cloud/api/1/groups/${encodeURIComponent(groupId)}/join`, {
        method: 'POST'
    });
}

async function inviteUserToGroup(groupId, userId) {
    return vrchatJson(`https://api.vrchat.cloud/api/1/groups/${encodeURIComponent(groupId)}/invites`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({ userId, UserId: userId })
    });
}

async function ensureBotInGroup(groupId) {
    const { response, json } = await joinGroup(groupId);
    const message = String(json?.error?.message || json?.message || '');

    if (response.statusCode >= 200 && response.statusCode < 300) {
        return { ok: true, joined: true, message: 'Joined group.' };
    }

    if (message.toLowerCase().includes('already a member')) {
        return { ok: true, joined: true, message: 'Already a group member.' };
    }

    return {
        ok: false,
        joined: false,
        message: message || `Group join failed with status ${response.statusCode}.`
    };
}

async function resolveVrchatUser(identifier) {
    const direct = await vrchatRequest(`https://api.vrchat.cloud/api/1/users/${encodeURIComponent(identifier)}`);
    const directJson = await direct.body.json();

    if (direct.statusCode === 200 && directJson && directJson.id) {
        return directJson;
    }

    const search = await vrchatRequest(`https://api.vrchat.cloud/api/1/users?search=${encodeURIComponent(identifier)}`);
    const searchJson = await search.body.json();

    if (!Array.isArray(searchJson) || searchJson.length === 0) {
        return null;
    }

    const lowerIdentifier = identifier.toLowerCase();
    const exactMatch = searchJson.find(user => {
        return [user.id, user.displayName, user.username].some(value => value && value.toLowerCase() === lowerIdentifier);
    });

    return exactMatch || searchJson[0];
}

async function fetchVrchatUserById(userId) {
    const response = await vrchatRequest(`https://api.vrchat.cloud/api/1/users/${encodeURIComponent(userId)}`);
    const json = await response.body.json();

    if (response.statusCode !== 200 || !json || !json.id) {
        return null;
    }

    return json;
}

async function postVerificationPanel(channel, guild) {
    const guildState = getGuildState(guild.id);
    const payload = {
        embeds: [makeVerificationPanel(guild, guildState)],
        components: [makeLinkButtons()]
    };

    if (guildState.verificationMessageId) {
        try {
            const existing = await channel.messages.fetch(guildState.verificationMessageId);
            await existing.edit(payload);
            return existing;
        } catch {
            guildState.verificationMessageId = null;
            saveState();
        }
    }

    const message = await channel.send(payload);
    guildState.verificationMessageId = message.id;
    saveState();
    return message;
}

function isVerificationOwner(interaction) {
    const pending = state.pending[interaction.user.id];
    return pending && pending.discordUserId === interaction.user.id;
}

function isCommandOwner(interaction) {
    return interaction.guild && (interaction.guild.ownerId === interaction.user.id || interaction.memberPermissions?.has(Discord.PermissionFlagsBits.ManageGuild));
}

function getGuildNicknameRecord(linkedRecord, guildId) {
    if (!linkedRecord.guildNicknames) {
        linkedRecord.guildNicknames = {};
    }

    if (!linkedRecord.guildNicknames[guildId]) {
        linkedRecord.guildNicknames[guildId] = {};
    }

    return linkedRecord.guildNicknames[guildId];
}

async function syncLinkedNickname(member, guildState, vrchatUser, linkedRecord) {
    const mode = guildState.nicknameMode || 'off';
    const nicknameRecord = getGuildNicknameRecord(linkedRecord, member.guild.id);
    const desiredNickname = buildNicknameForMode(member, vrchatUser, mode);

    if (mode === 'off') {
        if (!Object.prototype.hasOwnProperty.call(nicknameRecord, 'originalNickname')) {
            return { ok: true, message: 'Nickname replacement is disabled.' };
        }

        const restoreNickname = nicknameRecord.originalNickname || null;

        try {
            if (member.nickname !== restoreNickname) {
                await member.setNickname(restoreNickname, 'VRChat nickname reset');
            }

            nicknameRecord.appliedMode = 'off';
            saveState();
            return { ok: true, message: restoreNickname ? `Restored nickname to **${restoreNickname}**.` : 'Cleared the VRChat nickname.' };
        } catch (error) {
            console.error(error);
            return { ok: false, message: 'I could not restore that nickname.' };
        }
    }

    if (!desiredNickname) {
        return { ok: true, message: 'Nickname replacement is disabled.' };
    }

    if (!Object.prototype.hasOwnProperty.call(nicknameRecord, 'originalNickname')) {
        nicknameRecord.originalNickname = member.nickname || null;
    }

    try {
        if (member.nickname !== desiredNickname) {
            await member.setNickname(desiredNickname, 'VRChat nickname sync');
        }

        nicknameRecord.appliedMode = mode;
        saveState();
        return { ok: true, message: `Nickname updated to **${desiredNickname}**.` };
    } catch (error) {
        console.error(error);
        return { ok: false, message: 'I could not update that nickname.' };
    }
}

async function syncLinkedNicknamesForGuild(interaction, guildState) {
    if (!interaction.guild) {
        return { updated: 0, failed: 0, messages: [] };
    }

    const messages = [];
    let updated = 0;
    let failed = 0;

    for (const linkedRecord of Object.values(state.links)) {
        const member = await interaction.guild.members.fetch(linkedRecord.discordUserId).catch(() => null);
        if (!member || member.user.bot) {
            continue;
        }

        const vrchatUser = await fetchVrchatUserById(linkedRecord.vrchatUserId).catch(() => null) || {
            displayName: linkedRecord.displayName,
            username: linkedRecord.displayName
        };

        const result = await syncLinkedNickname(member, guildState, vrchatUser, linkedRecord);
        if (result.ok) {
            updated += 1;
        } else {
            failed += 1;
        }

        messages.push(result.message);
    }

    return { updated, failed, messages };
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const commands = [
        new Discord.SlashCommandBuilder()
            .setName('vrchat')
            .setDescription('VRChat account linking')
            .addSubcommand(subcommand => subcommand
                .setName('setup')
                .setDescription('Set the channel for the verification panel')
                .addChannelOption(option => option
                    .setName('channel')
                    .setDescription('Channel where the verification panel will be posted')
                    .addChannelTypes(Discord.ChannelType.GuildText)
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('user')
                .setDescription('Show the VRChat profile for a verified Discord user')
                .addUserOption(option => option
                    .setName('user')
                    .setDescription('Discord user to look up')
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('online')
                .setDescription('List verified server members currently online on VRChat'))
            .addSubcommandGroup(group => group
                .setName('group')
                .setDescription('Configure verified-user group invites')
                .addSubcommand(subcommand => subcommand
                    .setName('set')
                    .setDescription('Link a VRChat group to this server')
                    .addStringOption(option => option
                        .setName('group')
                        .setDescription('VRChat group ID or group link')
                        .setRequired(true)))
                .addSubcommand(subcommand => subcommand
                    .setName('status')
                    .setDescription('Show the linked VRChat group'))
                .addSubcommand(subcommand => subcommand
                    .setName('clear')
                    .setDescription('Unlink the VRChat group from this server')))
            .addSubcommand(subcommand => subcommand
                .setName('link')
                .setDescription('Start linking your Discord and VRChat account'))
            .addSubcommand(subcommand => subcommand
                .setName('status')
                .setDescription('Show your current VRChat link status'))
        ,new Discord.SlashCommandBuilder()
            .setName('config')
            .setDescription('Configure Discord verification settings')
            .addSubcommand(subcommand => subcommand
                .setName('status')
                .setDescription('Show the current verification settings'))
            .addSubcommand(subcommand => subcommand
                .setName('link-role')
                .setDescription('Set the role added when a VRChat account is linked')
                .addRoleOption(option => option
                    .setName('role')
                    .setDescription('Discord role to add on link')
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('clear-link-role')
                .setDescription('Clear the linked-account role'))
            .addSubcommand(subcommand => subcommand
                .setName('nickname-mode')
                .setDescription('Choose how linked users are renamed in this server')
                .addStringOption(option => option
                    .setName('mode')
                    .setDescription('Nickname format to apply')
                    .addChoices(
                        { name: 'Disabled', value: 'off' },
                        { name: '{username} ({VRChat Username})', value: 'username-paren' },
                        { name: '{username} - {VRChat Username}', value: 'username-dash' },
                        { name: 'Full replacement with the VRChat username', value: 'vrchat-only' }
                    )
                    .setRequired(true)))
            .addSubcommandGroup(group => group
                .setName('agegate')
                .setDescription('Configure age-gate settings')
                .addSubcommand(subcommand => subcommand
                    .setName('enable')
                    .setDescription('Require VRChat age verification for linking'))
                .addSubcommand(subcommand => subcommand
                    .setName('disable')
                    .setDescription('Disable age verification for linking'))
                .addSubcommand(subcommand => subcommand
                    .setName('set-role')
                    .setDescription('Set the role used when age-gated linking succeeds')
                    .addRoleOption(option => option
                        .setName('role')
                        .setDescription('Discord role to add when age verification passes')
                        .setRequired(true)))
                .addSubcommand(subcommand => subcommand
                    .setName('clear-role')
                    .setDescription('Use the link role for age-gated linking'))
                .addSubcommand(subcommand => subcommand
                    .setName('set-action')
                    .setDescription('Choose what happens if age verification fails')
                    .addStringOption(option => option
                        .setName('action')
                        .setDescription('Action to take on failure')
                        .addChoices(
                            { name: 'None', value: 'none' },
                            { name: 'Kick', value: 'kick' },
                            { name: 'Ban', value: 'ban' }
                        )
                        .setRequired(true)))
                .addSubcommand(subcommand => subcommand
                    .setName('status')
                    .setDescription('Show age-gate configuration')))
    ];

    const rest = new Discord.REST({ version: '10' }).setToken(token);

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Discord.Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton()) {
            if (!isButtonOwner(interaction)) {
                return rejectNotYourButton(interaction);
            }

        if (interaction.customId.startsWith('grade-')) {
            const cached = cache.get(interaction.user.id);

            if (!cached) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'Grade Lookup', description: 'That lookup has expired.', color: 0xff4d4d })]
                });
            }

            if (cached.requesterId !== interaction.user.id) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'Grade Lookup', description: 'This lookup belongs to another user.', color: 0xff4d4d })]
                });
            }

            if (interaction.customId === 'grade-next') {
                cached.index = (cached.index + 1) % cached.users.length;
                await interaction.deferUpdate();
                return cached.interaction.editReply({
                    embeds: [makeGradeEmbed(cached.users[cached.index])],
                    components: [makeGradeButtons()]
                });
            }

            if (interaction.customId === 'grade-cancel') {
                cache.delete(interaction.user.id);
                await interaction.deferUpdate();
                return cached.interaction.editReply({
                    embeds: [makeEmbed({ title: 'Grade Lookup', description: 'Lookup canceled.', color: 0xffcc4d })],
                    components: []
                });
            }

            if (interaction.customId === 'grade-confirm') {
                cache.delete(interaction.user.id);
                await interaction.deferUpdate();
                return cached.interaction.editReply({
                    embeds: [makeEmbed({
                        title: 'Grade Lookup',
                        description: `Selected **${cached.users[cached.index].displayName}**`,
                        fields: [{ name: 'Selected Profile', value: 'Ready to use', inline: false }]
                    })],
                    components: []
                });
            }

            return interaction.reply({
                embeds: [makeEmbed({ title: 'Grade Lookup', description: 'Unknown action.', color: 0xff4d4d })]
            });
        }

        if (interaction.customId.startsWith('vrchat-online-')) {
            if (!isButtonOwner(interaction)) {
                return rejectNotYourButton(interaction);
            }

            const session = getOnlineSession(interaction.message.id);

            if (interaction.customId === 'vrchat-online-prev') {
                await interaction.deferUpdate();
                const nextPage = Math.max(0, session.pageIndex - 1);
                const view = await buildOnlineView(interaction, nextPage);
                return interaction.editReply(view);
            }

            if (interaction.customId === 'vrchat-online-next') {
                await interaction.deferUpdate();
                const nextPage = session.pageIndex + 1;
                const view = await buildOnlineView(interaction, nextPage);
                return interaction.editReply(view);
            }

            if (interaction.customId === 'vrchat-online-refresh') {
                await interaction.deferUpdate();
                const view = await buildOnlineView(interaction, session.pageIndex);
                return interaction.editReply(view);
            }

            return interaction.reply({
                embeds: [makeEmbed({ title: 'VRChat Online', description: 'Unknown action.', color: 0xff4d4d })]
            });
        }

        if (interaction.customId === 'vrchat-link-start') {
            const linked = state.links[interaction.user.id];

            if (linked) {
                return interaction.reply({
                    ephemeral: true,
                    embeds: [makeEmbed({
                        title: 'VRChat Verification',
                        description: `Account **${linked.displayName || 'Unknown'}** is already linked.`,
                        color: 0xffcc4d
                    })],
                    components: [makeUnlinkButton()]
                });
            }

            const modal = new Discord.ModalBuilder()
                .setCustomId('vrchat-link-modal')
                .setTitle('Link VRChat Account');

            const linkInput = new Discord.TextInputBuilder()
                .setCustomId('vrchat-profile-link')
                .setLabel('VRChat profile link')
                .setStyle(Discord.TextInputStyle.Short)
                .setPlaceholder('https://vrchat.com/home/user/usr_...')
                .setRequired(true)
                .setMinLength(10)
                .setMaxLength(200);

            modal.addComponents(new Discord.ActionRowBuilder().addComponents(linkInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'vrchat-link-check') {
            const pending = state.pending[interaction.user.id];

            if (!pending) {
                return interaction.reply({
                    ephemeral: true,
                    embeds: [makeEmbed({ title: 'VRChat Verification', description: 'No verification is waiting for your account.', color: 0xff4d4d })]
                });
            }

            const user = await fetchVrchatUserById(pending.vrchatUserId);

            if (!user) {
                return interaction.reply({
                    ephemeral: true,
                    embeds: [makeEmbed({ title: 'VRChat Verification', description: 'I could not load that VRChat profile right now. Try again in a moment.', color: 0xff4d4d })]
                });
            }

            const bio = String(user.bio || '').toUpperCase();
            if (!bio.includes(pending.code)) {
                return interaction.reply({
                    ephemeral: true,
                    embeds: [makeEmbed({
                        title: 'VRChat Verification',
                        description: [
                            `I could not find the code \`${pending.code}\` in **${user.displayName}**'s bio.`,
                            'Add the code to your bio and press **Check Verification** again.'
                        ].join('\n'),
                        color: 0xffcc4d
                    })]
                });
            }

            const guildState = getGuildState(interaction.guildId);
            const ageGateEnabled = Boolean(guildState.ageGateEnabled);
            const verified = isAgeVerified(user);

            if (ageGateEnabled && !verified) {
                await applyAgeGateFailure(interaction, guildState, user);
                return;
            }

            state.links[interaction.user.id] = {
                discordUserId: interaction.user.id,
                vrchatUserId: user.id,
                displayName: user.displayName,
                linkedAt: new Date().toISOString()
            };
            delete state.pending[interaction.user.id];
            saveState();

            const roleIds = [guildState.linkRoleId];
            if (ageGateEnabled && guildState.ageGateRoleId && guildState.ageGateRoleId !== guildState.linkRoleId) {
                roleIds.push(guildState.ageGateRoleId);
            }

            const roleResult = await assignRolesToMember(interaction, roleIds);
            const groupInviteText = await sendGroupInviteIfConfigured(guildState, user);
            const member = await fetchGuildMember(interaction);
            const linkedRecord = state.links[interaction.user.id];
            let nicknameResult = { ok: true, message: 'Nickname replacement is disabled.' };

            if (member && linkedRecord) {
                nicknameResult = await syncLinkedNickname(member, guildState, user, linkedRecord);
            }

            return interaction.reply({
                ephemeral: true,
                embeds: [makeEmbed({
                    title: 'VRChat Verification Complete',
                    description: `**${user.displayName}** is now linked.`,
                    fields: [
                        { name: 'Age Check', value: verified ? 'Passed' : 'Not required', inline: false },
                        { name: 'Discord Roles', value: roleResult.message, inline: false },
                        { name: 'Nickname', value: nicknameResult.message, inline: false },
                        ...(groupInviteText ? [{ name: 'Group Invite', value: groupInviteText, inline: false }] : [])
                    ]
                })],
            });
        }

        if (interaction.customId === 'vrchat-link-unlink') {
            const linked = state.links[interaction.user.id];

            if (!linked) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Link', description: 'No linked account was found for your Discord account.', color: 0xff4d4d })]
                });
            }

            const member = await fetchGuildMember(interaction);
            if (member) {
                const nicknameRecord = linked.guildNicknames?.[interaction.guildId];
                if (nicknameRecord && Object.prototype.hasOwnProperty.call(nicknameRecord, 'originalNickname')) {
                    try {
                        await member.setNickname(nicknameRecord.originalNickname || null, 'VRChat unlink nickname reset');
                    } catch (error) {
                        console.error(error);
                    }
                }
            }

            delete state.links[interaction.user.id];
            delete state.pending[interaction.user.id];
            saveState();

            return interaction.update({
                embeds: [makeEmbed({
                    title: 'VRChat Link',
                    description: `Unlinked **${linked.displayName || 'your VRChat account'}** from this Discord account.`,
                    color: 0xffcc4d
                })],
                components: []
            });
        }

        return;
    }

        if (interaction.isModalSubmit()) {
            if (interaction.customId !== 'vrchat-link-modal') {
                return;
            }

        const rawLink = interaction.fields.getTextInputValue('vrchat-profile-link');
        const identifier = extractProfileIdentifier(rawLink);

        if (!identifier) {
            return interaction.reply({
                ephemeral: true,
                embeds: [makeEmbed({
                    title: 'VRChat Verification',
                    description: 'That does not look like a valid VRChat profile link.',
                    color: 0xff4d4d
                })]
            });
        }

        const user = await resolveVrchatUser(identifier);

        if (!user || !user.id) {
            return interaction.reply({
                ephemeral: true,
                embeds: [makeEmbed({
                    title: 'VRChat Verification',
                    description: 'I could not find a VRChat profile for that link.',
                    color: 0xff4d4d
                })]
            });
        }

        const existingLink = Object.values(state.links).find(link => link.vrchatUserId === user.id && link.discordUserId !== interaction.user.id);
        if (existingLink) {
            return interaction.reply({
                ephemeral: true,
                embeds: [makeEmbed({
                    title: 'VRChat Verification',
                    description: 'That VRChat account is already linked to another Discord account.',
                    color: 0xff4d4d
                })]
            });
        }

        const code = generateVerificationCode();
        state.pending[interaction.user.id] = {
            discordUserId: interaction.user.id,
            guildId: interaction.guildId,
            vrchatUserId: user.id,
            vrchatDisplayName: user.displayName,
            code,
            createdAt: new Date().toISOString()
        };
        saveState();

        return interaction.reply({
            ephemeral: true,
            embeds: [makeEmbed({
                title: 'VRChat Verification Started',
                description: [
                    `Found **${user.displayName}** (${user.id}).`,
                    '',
                    `Add this code to your VRChat bio: \`${code}\``,
                    'When your bio is updated, press **Check Verification**.'
                ].join('\n'),
                fields: [
                    { name: 'Profile Link', value: rawLink, inline: false }
                ]
            })]
        });
    }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'grade') {
        const username = interaction.options.getString('username', true);
        const rusers = await vrchatRequest(`https://api.vrchat.cloud/api/1/users?search=${encodeURIComponent(username)}`);
        const ruser = await vrchatRequest(`https://api.vrchat.cloud/api/1/users/${encodeURIComponent(username)}`);
        const users = await rusers.body.json();
        const user = await ruser.body.json();
        const lusers = [...(user && user.id ? [user] : []), ...(Array.isArray(users) && users.length > 0 ? users : [])];

        if (lusers.length === 0) {
            return interaction.reply({
                embeds: [makeEmbed({ title: 'VRChat User Lookup', description: 'Nothing was found for that search.', color: 0xff4d4d })]
            });
        }

        cache.set(interaction.user.id, { index: 0, users: lusers, interaction, requesterId: interaction.user.id });

        const message = await interaction.reply({
            embeds: [makeGradeEmbed(lusers[0])],
            components: [makeGradeButtons()],
            fetchReply: true
        });

        registerButtonOwner(message.id, interaction.user.id);
    }

        if (interaction.commandName === 'vrchat') {
        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'setup') {
            if (!interaction.guild || !isCommandOwner(interaction)) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Verification', description: 'Only the server owner or a user with Manage Server can set the verification channel.', color: 0xff4d4d })]
                });
            }

            const channel = interaction.options.getChannel('channel', true);
            if (!channel.isTextBased()) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Verification', description: 'Please choose a text channel.', color: 0xff4d4d })]
                });
            }

            const guildState = getGuildState(interaction.guildId);
            guildState.verificationChannelId = channel.id;
            saveState();

            try {
                const panelMessage = await postVerificationPanel(channel, interaction.guild);
                return interaction.reply({
                    embeds: [makeEmbed({
                        title: 'VRChat Verification',
                        description: `Verification panel posted in ${channel}.`
                    })]
                });
            } catch (error) {
                console.error(error);
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Verification', description: 'I could not post the verification panel in that channel.', color: 0xff4d4d })]
                });
            }
        }

        if (subcommand === 'user') {
            const targetUser = interaction.options.getUser('user', true);
            const linked = state.links[targetUser.id];

            if (!linked) {
                return interaction.reply({
                    embeds: [makeEmbed({
                        title: 'VRChat Profile',
                        description: `${targetUser} has not linked a VRChat account yet.`,
                        color: 0xffcc4d
                    })],
                    ephemeral: true
                });
            }

            const vrchatUser = await fetchVrchatUserById(linked.vrchatUserId);

            if (!vrchatUser) {
                return interaction.reply({
                    embeds: [makeEmbed({
                        title: 'VRChat Profile',
                        description: 'I could not load that VRChat profile right now.',
                        color: 0xff4d4d
                    })],
                    ephemeral: true
                });
            }

            return interaction.reply({
                embeds: [makeVerifiedUserProfileEmbed(targetUser, vrchatUser)]
            });
        }

        if (subcommand === 'online') {
            const view = await buildOnlineView(interaction, 0);
            const message = await interaction.reply({
                ...view,
                fetchReply: true
            });

            const session = getOnlineSession(interaction.id);
            onlineSessions.set(message.id, session);
            onlineSessions.delete(interaction.id);
            registerButtonOwner(message.id, interaction.user.id);
        }

        if (subcommandGroup === 'group') {
            const groupSubcommand = interaction.options.getSubcommand();

            if (groupSubcommand === 'set') {
                if (!interaction.guild || !isCommandOwner(interaction)) {
                    return interaction.reply({
                        embeds: [makeEmbed({ title: 'VRChat Group', description: 'Only the server owner or a user with Manage Server can link a VRChat group.', color: 0xff4d4d })],
                        ephemeral: true
                    });
                }

                const rawGroup = interaction.options.getString('group', true);
                const groupId = extractGroupIdentifier(rawGroup);

                if (!groupId) {
                    return interaction.reply({
                        embeds: [makeEmbed({ title: 'VRChat Group', description: 'That does not look like a valid VRChat group ID or link.', color: 0xff4d4d })],
                        ephemeral: true
                    });
                }

                const group = await fetchGroup(groupId);
                if (!group) {
                    return interaction.reply({
                        embeds: [makeEmbed({ title: 'VRChat Group', description: 'I could not find that VRChat group.', color: 0xff4d4d })],
                        ephemeral: true
                    });
                }

                const groupJoinResult = await ensureBotInGroup(group.id);
                const guildState = getGuildState(interaction.guildId);
                guildState.groupId = group.id;
                guildState.groupName = group.name || group.displayName || group.id;
                guildState.groupPrivacy = group.privacy || group.joinState || null;
                guildState.groupLinkedAt = new Date().toISOString();
                guildState.groupJoinStatus = groupJoinResult.ok ? 'joined' : 'join_failed';
                saveState();

                if (guildState.verificationChannelId) {
                    const channel = await interaction.guild.channels.fetch(guildState.verificationChannelId).catch(() => null);
                    if (channel && channel.isTextBased()) {
                        await postVerificationPanel(channel, interaction.guild).catch(console.error);
                    }
                }

                return interaction.reply({
                    embeds: [makeEmbed({
                        title: 'VRChat Group',
                        description: `Linked **${guildState.groupName}** to this server.`,
                        fields: [
                            { name: 'Bot Join Status', value: groupJoinResult.ok ? 'Bot joined the group.' : `Bot could not join automatically: ${groupJoinResult.message}`, inline: false }
                        ],
                        color: groupJoinResult.ok ? 0x2b90ff : 0xffcc4d
                    })],
                    ephemeral: true
                });
            }

            if (groupSubcommand === 'status') {
                const guildState = getGuildState(interaction.guildId);

                return interaction.reply({
                    embeds: [makeEmbed({
                        title: 'VRChat Group',
                        description: guildState.groupId
                            ? `Linked group: **${guildState.groupName || 'Configured'}**`
                            : 'No VRChat group has been linked yet.',
                        fields: guildState.groupId ? [
                            { name: 'Bot Join Status', value: guildState.groupJoinStatus === 'joined' ? 'Bot joined the group.' : 'Bot could not join automatically.', inline: false }
                        ] : []
                    })],
                    ephemeral: true
                });
            }

            if (groupSubcommand === 'clear') {
                if (!interaction.guild || !isCommandOwner(interaction)) {
                    return interaction.reply({
                        embeds: [makeEmbed({ title: 'VRChat Group', description: 'Only the server owner or a user with Manage Server can unlink a VRChat group.', color: 0xff4d4d })],
                        ephemeral: true
                    });
                }

                const guildState = getGuildState(interaction.guildId);
                delete guildState.groupId;
                delete guildState.groupName;
                delete guildState.groupPrivacy;
                delete guildState.groupLinkedAt;
                delete guildState.groupJoinStatus;
                saveState();

                if (guildState.verificationChannelId) {
                    const channel = await interaction.guild.channels.fetch(guildState.verificationChannelId).catch(() => null);
                    if (channel && channel.isTextBased()) {
                        await postVerificationPanel(channel, interaction.guild).catch(console.error);
                    }
                }

                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Group', description: 'Cleared the linked VRChat group.', color: 0xffcc4d })],
                    ephemeral: true
                });
            }
        }

        if (subcommand === 'status') {
            const guildState = getGuildState(interaction.guildId);

            return interaction.reply({
                embeds: [makeConfigStatusEmbed(interaction.guild, guildState)],
                ephemeral: true
            });
        }

        if (subcommand === 'link-role') {
            if (!interaction.guild || !isCommandOwner(interaction)) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Only the server owner or a user with Manage Server can change the link role.', color: 0xff4d4d })],
                    ephemeral: true
                });
            }

            const role = interaction.options.getRole('role', true);
            const guildState = getGuildState(interaction.guildId);
            guildState.linkRoleId = role.id;
            saveState();

            await upsertVerificationPanelForGuild(interaction, guildState);

            return interaction.reply({
                embeds: [makeEmbed({
                    title: 'VRChat Config',
                    description: `Link role set to ${role}.`,
                    color: 0x2b90ff
                })],
                ephemeral: true
            });
        }

        if (subcommand === 'clear-link-role') {
            if (!interaction.guild || !isCommandOwner(interaction)) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Only the server owner or a user with Manage Server can clear the link role.', color: 0xff4d4d })],
                    ephemeral: true
                });
            }

            const guildState = getGuildState(interaction.guildId);
            delete guildState.linkRoleId;
            saveState();

            await upsertVerificationPanelForGuild(interaction, guildState);

            return interaction.reply({
                embeds: [makeEmbed({
                    title: 'VRChat Config',
                    description: 'Link role cleared.',
                    color: 0xffcc4d
                })],
                ephemeral: true
            });
        }

        if (subcommandGroup === 'agegate') {
            const ageSubcommand = interaction.options.getSubcommand();

            if (!interaction.guild || !isCommandOwner(interaction)) {
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Only the server owner or a user with Manage Server can change age-gate settings.', color: 0xff4d4d })],
                    ephemeral: true
                });
            }

            const guildState = getGuildState(interaction.guildId);

            if (ageSubcommand === 'enable') {
                guildState.ageGateEnabled = true;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Age gate enabled.', color: 0x2b90ff })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'disable') {
                guildState.ageGateEnabled = false;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Age gate disabled.', color: 0xffcc4d })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'set-role') {
                const role = interaction.options.getRole('role', true);
                guildState.ageGateRoleId = role.id;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: `Age-gate role set to ${role}.`, color: 0x2b90ff })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'clear-role') {
                delete guildState.ageGateRoleId;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Age-gate role cleared.', color: 0xffcc4d })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'set-action') {
                const action = interaction.options.getString('action', true);
                guildState.ageGateFailAction = action;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);
                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: `Age-gate fail action set to **${action}**.`, color: 0x2b90ff })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'status') {
                return interaction.reply({
                    embeds: [makeConfigStatusEmbed(interaction.guild, guildState)],
                    ephemeral: true
                });
            }
        }

        if (subcommand === 'link') {
            const linked = state.links[interaction.user.id];

            if (linked) {
                return interaction.reply({
                    ephemeral: true,
                    embeds: [makeEmbed({
                        title: 'VRChat Link',
                        description: `Account **${linked.displayName || 'Unknown'}** is already linked.`,
                        color: 0xffcc4d
                    })],
                    components: [makeUnlinkButton()]
                });
            }

            const modal = new Discord.ModalBuilder()
                .setCustomId('vrchat-link-modal')
                .setTitle('Link VRChat Account');

            const linkInput = new Discord.TextInputBuilder()
                .setCustomId('vrchat-profile-link')
                .setLabel('VRChat profile link')
                .setStyle(Discord.TextInputStyle.Short)
                .setPlaceholder('https://vrchat.com/home/user/usr_...')
                .setRequired(true)
                .setMinLength(10)
                .setMaxLength(200);

            modal.addComponents(new Discord.ActionRowBuilder().addComponents(linkInput));
            return interaction.showModal(modal);
        }

        if (subcommand === 'status') {
            return interaction.reply({
                embeds: [makeStatusEmbed(interaction.user.id, interaction.guildId)],
                ephemeral: true
            });
        }
    }

    if (interaction.commandName === 'config') {
        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();

        if (!interaction.guild || !isCommandOwner(interaction)) {
            return interaction.reply({
                embeds: [makeEmbed({ title: 'VRChat Config', description: 'Only the server owner or a user with Manage Server can change verification settings.', color: 0xff4d4d })],
                ephemeral: true
            });
        }

        const guildState = getGuildState(interaction.guildId);

        if (subcommand === 'status') {
            return interaction.reply({
                embeds: [makeConfigStatusEmbed(interaction.guild, guildState)],
                ephemeral: true
            });
        }

        if (subcommand === 'link-role') {
            const role = interaction.options.getRole('role', true);
            guildState.linkRoleId = role.id;
            saveState();
            await upsertVerificationPanelForGuild(interaction, guildState);

            return interaction.reply({
                embeds: [makeEmbed({ title: 'VRChat Config', description: `Link role set to ${role}.`, color: 0x2b90ff })],
                ephemeral: true
            });
        }

        if (subcommand === 'clear-link-role') {
            delete guildState.linkRoleId;
            saveState();
            await upsertVerificationPanelForGuild(interaction, guildState);

            return interaction.reply({
                embeds: [makeEmbed({ title: 'VRChat Config', description: 'Link role cleared.', color: 0xffcc4d })],
                ephemeral: true
            });
        }

        if (subcommand === 'nickname-mode') {
            const mode = interaction.options.getString('mode', true);
            guildState.nicknameMode = mode;
            saveState();

            const syncResult = await syncLinkedNicknamesForGuild(interaction, guildState);

            return interaction.reply({
                embeds: [makeEmbed({
                    title: 'VRChat Config',
                    description: `Nickname mode set to **${formatNicknameMode(mode)}**.`,
                    fields: [
                        { name: 'Updated Members', value: String(syncResult.updated), inline: true },
                        { name: 'Failed Updates', value: String(syncResult.failed), inline: true }
                    ],
                    color: 0x2b90ff
                })],
                ephemeral: true
            });
        }

        if (subcommandGroup === 'agegate') {
            const ageSubcommand = interaction.options.getSubcommand();

            if (ageSubcommand === 'enable') {
                guildState.ageGateEnabled = true;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);

                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Age gate enabled.', color: 0x2b90ff })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'disable') {
                guildState.ageGateEnabled = false;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);

                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Age gate disabled.', color: 0xffcc4d })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'set-role') {
                const role = interaction.options.getRole('role', true);
                guildState.ageGateRoleId = role.id;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);

                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: `Age-gate role set to ${role}.`, color: 0x2b90ff })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'clear-role') {
                delete guildState.ageGateRoleId;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);

                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: 'Age-gate role cleared.', color: 0xffcc4d })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'set-action') {
                const action = interaction.options.getString('action', true);
                guildState.ageGateFailAction = action;
                saveState();
                await upsertVerificationPanelForGuild(interaction, guildState);

                return interaction.reply({
                    embeds: [makeEmbed({ title: 'VRChat Config', description: `Age-gate fail action set to **${action}**.`, color: 0x2b90ff })],
                    ephemeral: true
                });
            }

            if (ageSubcommand === 'status') {
                return interaction.reply({
                    embeds: [makeConfigStatusEmbed(interaction.guild, guildState)],
                    ephemeral: true
                });
            }
        }
        }
    } catch (error) {
        if (error?.code !== 10062) {
            console.error(error);
        }
    }
});

if (!token) {
    throw new Error('Missing Discord bot token. Set config.TOKEN or DISCORD_TOKEN.');
}

client.login(token);
