const settings = require("../../settings");
const style = require('../../lib/messageStyle');
const { channelInfo } = require('../../lib/messageConfig');
async function aliveCommand(sock, chatId, message) {
    try {
        const message1 = style.card('STATUS.SYS', [
            ...style.entries([
                ['Bot', settings.botName || 'Optimus Bot'],
                ['Version', settings.version || '—'],
                ['Status', 'ONLINE'],
            ]),
            '',
            style.tag('system', 'ALL SYSTEMS NOMINAL'),
            '',
            style.quote(`Type ${'.menu'} for the full command index`),
        ]);

        await sock.sendMessage(chatId, {
            text: message1,
            contextInfo: { ...channelInfo.contextInfo, forwardingScore: 999 }
        }, { quoted: message });
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { text: 'Bot is alive and running!' }, { quoted: message });
    }
}

module.exports = {
    name: 'alive',
    aliases: [],
    category: 'general',
    description: 'Check if the bot is online',
    usage: '.alive',
    ownerOnly: false,
    modOnly: false,
    groupOnly: false,
    privateOnly: false,
    adminOnly: false,
    botAdminNeeded: false,
    async execute(sock, message, args, extra) {
        await aliveCommand(sock, extra.chatId, message);
    },

};