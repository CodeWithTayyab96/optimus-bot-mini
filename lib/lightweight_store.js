const fs = require('fs')
const STORE_FILE = './baileys_store.json'

// Config: keep last 20 messages per chat (configurable) - More aggressive for lower RAM
let MAX_MESSAGES = 20
// Hard caps so a long-running process cannot grow these maps without bound.
// A single bot realistically sees far fewer contacts than this; the cap only
// ever bites after months of uptime in a very large account.
let MAX_CONTACTS = 5000
let MAX_CHATS = 2000

// Try to read config from settings
try {
    const settings = require('../settings.js')
    if (settings.maxStoreMessages && typeof settings.maxStoreMessages === 'number') {
        MAX_MESSAGES = settings.maxStoreMessages
    }
    if (typeof settings.maxStoreContacts === 'number' && settings.maxStoreContacts > 0) {
        MAX_CONTACTS = settings.maxStoreContacts
    }
    if (typeof settings.maxStoreChats === 'number' && settings.maxStoreChats > 0) {
        MAX_CHATS = settings.maxStoreChats
    }
} catch (e) {
    // Use default if settings not available
}

/** Drop the oldest keys from a plain object until it is within `max`. */
function trimObject(obj, max) {
    const keys = Object.keys(obj)
    if (keys.length <= max) return 0
    const excess = keys.length - max
    for (let i = 0; i < excess; i++) delete obj[keys[i]]
    return excess
}

const store = {
    messages: {},
    contacts: {},
    chats: {},

    readFromFile(filePath = STORE_FILE) {
        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
                this.contacts = data.contacts || {}
                this.chats = data.chats || {}
                this.messages = data.messages || {}
                
                // Clean up any existing data to match new format
                this.cleanupData()
                trimObject(this.contacts, MAX_CONTACTS)
                trimObject(this.chats, MAX_CHATS)
            }
        } catch (e) {
            console.warn('Failed to read store file:', e.message)
        }
    },

    writeToFile(filePath = STORE_FILE) {
        try {
            const data = JSON.stringify({
                contacts: this.contacts,
                chats: this.chats,
                messages: this.messages
            })
            fs.writeFileSync(filePath, data)
        } catch (e) {
            console.warn('Failed to write store file:', e.message)
        }
    },

    cleanupData() {
        // Convert old format messages to new format if needed
        if (this.messages) {
            Object.keys(this.messages).forEach(jid => {
                if (typeof this.messages[jid] === 'object' && !Array.isArray(this.messages[jid])) {
                    // Old format - convert to new format
                    const messages = Object.values(this.messages[jid])
                    this.messages[jid] = messages.slice(-MAX_MESSAGES)
                }
            })
        }
    },

    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            messages.forEach(msg => {
                if (!msg.key?.remoteJid) return
                const jid = msg.key.remoteJid
                this.messages[jid] = this.messages[jid] || []

                // push new message
                this.messages[jid].push(msg)

                // trim old ones
                if (this.messages[jid].length > MAX_MESSAGES) {
                    this.messages[jid] = this.messages[jid].slice(-MAX_MESSAGES)
                }
            })
        })

        ev.on('contacts.update', (contacts) => {
            contacts.forEach(contact => {
                if (contact.id) {
                    this.contacts[contact.id] = {
                        id: contact.id,
                        name: contact.notify || contact.name || ''
                    }
                }
            })
            trimObject(this.contacts, MAX_CONTACTS)
        })

        ev.on('chats.set', (chats) => {
            this.chats = {}
            chats.forEach(chat => {
                this.chats[chat.id] = { id: chat.id, subject: chat.subject || '' }
            })
            trimObject(this.chats, MAX_CHATS)
        })
    },

    async loadMessage(jid, id) {
        return this.messages[jid]?.find(m => m.key.id === id) || null
    },

    // Get store statistics
    getStats() {
        let totalMessages = 0
        let totalContacts = Object.keys(this.contacts).length
        let totalChats = Object.keys(this.chats).length
        
        Object.values(this.messages).forEach(chatMessages => {
            if (Array.isArray(chatMessages)) {
                totalMessages += chatMessages.length
            }
        })
        
        return {
            messages: totalMessages,
            contacts: totalContacts,
            chats: totalChats,
            maxMessagesPerChat: MAX_MESSAGES,
            maxContacts: MAX_CONTACTS,
            maxChats: MAX_CHATS
        }
    }
}

module.exports = store
