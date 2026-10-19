const style = require('../../lib/messageStyle');

// A broadcast to N groups is the definition of a bulk send, and WhatsApp's
// anti-spam heuristics look at exactly that: many near-identical messages to
// many different chats in a short window. Pacing is what separates "the owner
// asked for this" from "this number is a spam cannon".
const SEND_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS) || 1200;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    name: 'broadcast',
    aliases: ['bc'],
    category: 'owner',
    description: 'Broadcast a message to all groups',
    usage: '.broadcast <message>',
    ownerOnly: true,
    modOnly: false,
    groupOnly: false,
    privateOnly: false,
    adminOnly: false,
    botAdminNeeded: false,
    async execute(sock, message, args, extra) {
        try {
            if (args.length === 0) {
                return extra.reply(style.invalidInput('Provide a message to broadcast.', `${extra.prefix}broadcast <message>`, { box: false }));
            }

            const broadcastText = args.join(' ');

            const chats = await sock.groupFetchAllParticipating();
            const groups = Object.values(chats);

            if (!groups.length) {
                return extra.reply(style.warning('The bot is not in any groups, so there is nothing to broadcast to.', { box: false }));
            }

            // One at a time, spaced out. A tight loop over every group is the
            // pattern that gets a number restricted, and nothing about the
            // content justifies the risk.
            let success = 0;
            let failed = 0;
            const failures = [];

            for (let i = 0; i < groups.length; i++) {
                try {
                    await sock.sendMessage(groups[i].id, {
                        text: `📢 *BROADCAST MESSAGE*\n\n${broadcastText}\n\n_This is a broadcast message from the bot owner_`
                    });
                    success++;
                } catch (e) {
                    failed++;
                    if (failures.length < 5) failures.push(e.message);
                }
                if (i < groups.length - 1) await sleep(SEND_DELAY_MS);
            }

            await extra.reply(style.card('BROADCAST.SYS', [
                ...style.fields([
                    ['Groups', String(groups.length)],
                    ['Delivered', String(success)],
                    ['Failed', failed ? String(failed) : 'NONE'],
                ]),
                ...(failures.length ? ['', style.tag('warning', `FIRST FAILURE: ${failures[0]}`)] : []),
                '',
                style.tag('info', `PACED AT ${(SEND_DELAY_MS / 1000).toFixed(1)}S PER GROUP`),
            ]));
        } catch (error) {
            console.error('Broadcast command error:', error);
            await extra.reply(style.error('Failed to broadcast the message.', { box: false }));
        }
    },

    // Exported for tests.
    _test: { SEND_DELAY_MS, sleep },
};
