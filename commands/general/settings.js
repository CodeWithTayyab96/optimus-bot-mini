const fs = require('fs');
const style = require('../../lib/messageStyle');

function readJsonSafe(path, fallback) {
    try {
        const txt = fs.readFileSync(path, 'utf8');
        return JSON.parse(txt);
    } catch (_) {
        return fallback;
    }
}

const isOwnerOrSudo = require('../../lib/isOwner');
const { readMode } = require('../../lib/mode');

async function settingsCommand(sock, chatId, message) {
    try {
        const senderId = message.key.participant || message.key.remoteJid;
        const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
        
        if (!message.key.fromMe && !isOwner) {
            await sock.sendMessage(chatId, { text: 'Only bot owner can use this command!' }, { quoted: message });
            return;
        }

        const isGroup = chatId.endsWith('@g.us');
        const dataDir = './data';

        const mode = { isPublic: readMode() };
        const autoStatus = readJsonSafe(`${dataDir}/autoStatus.json`, { enabled: false });
        const autoread = readJsonSafe(`${dataDir}/autoread.json`, { enabled: false });
        const autotyping = readJsonSafe(`${dataDir}/autotyping.json`, { enabled: false });
        const pmblocker = readJsonSafe(`${dataDir}/pmblocker.json`, { enabled: false });
        const anticall = readJsonSafe(`${dataDir}/anticall.json`, { enabled: false });
        const userGroupData = readJsonSafe(`${dataDir}/userGroupData.json`, {
            antilink: {}, antibadword: {}, welcome: {}, goodbye: {}, chatbot: {}, antitag: {}
        });
        const autoReaction = Boolean(userGroupData.autoReaction);

        // Per-group features
        const groupId = isGroup ? chatId : null;
        const antilinkOn = groupId ? Boolean(userGroupData.antilink && userGroupData.antilink[groupId]) : false;
        const antibadwordOn = groupId ? Boolean(userGroupData.antibadword && userGroupData.antibadword[groupId]) : false;
        const welcomeOn = groupId ? Boolean(userGroupData.welcome && userGroupData.welcome[groupId]) : false;
        const goodbyeOn = groupId ? Boolean(userGroupData.goodbye && userGroupData.goodbye[groupId]) : false;
        const chatbotOn = groupId ? Boolean(userGroupData.chatbot && userGroupData.chatbot[groupId]) : false;
        const antitagCfg = groupId ? (userGroupData.antitag && userGroupData.antitag[groupId]) : null;

        // The numbered configuration card from the design reference: one line
        // per switch, state as ENABLED/DISABLED rather than ON/OFF prose.
        const onOff = (v) => (v ? 'ENABLED' : 'DISABLED');
        const lines = [];
        lines.push(...style.entries([
            ['Mode', mode.isPublic ? 'PUBLIC' : 'PRIVATE'],
            ['Auto status', onOff(autoStatus.enabled)],
            ['Autoread', onOff(autoread.enabled)],
            ['Autotyping', onOff(autotyping.enabled)],
            ['PM blocker', onOff(pmblocker.enabled)],
            ['Anticall', onOff(anticall.enabled)],
            ['Auto react', onOff(autoReaction)],
        ]));

        if (groupId) {
            const group = [
                ['Antilink', antilinkOn ? `ENABLED (${userGroupData.antilink[groupId].action || 'delete'})` : 'DISABLED'],
                ['Antibadword', antibadwordOn ? `ENABLED (${userGroupData.antibadword[groupId].action || 'delete'})` : 'DISABLED'],
                ['Welcome', onOff(welcomeOn)],
                ['Goodbye', onOff(goodbyeOn)],
                ['Chatbot', onOff(chatbotOn)],
                ['Antitag', (antitagCfg && antitagCfg.enabled) ? `ENABLED (${antitagCfg.action || 'delete'})` : 'DISABLED'],
            ];
            lines.push('', style.tag('system', `GROUP OVERRIDES · ${groupId}`), '');
            lines.push(...style.entries(group));
        } else {
            lines.push('', style.tag('info', 'PER-GROUP SETTINGS APPEAR WHEN USED INSIDE A GROUP'));
        }

        await sock.sendMessage(chatId, {
            text: style.card('CONFIG.SYS', lines),
        }, { quoted: message });
    } catch (error) {
        console.error('Error in settings command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to read settings.' }, { quoted: message });
    }
}

module.exports = {
    name: 'settings',
    aliases: [],
    category: 'general',
    description: 'Show current bot settings',
    usage: '.settings',
    ownerOnly: false,
    modOnly: false,
    groupOnly: false,
    privateOnly: false,
    adminOnly: false,
    botAdminNeeded: false,
    async execute(sock, message, args, extra) {
        await settingsCommand(sock, extra.chatId, message);
    },

};


