// --- Import Libraries (ES Modules syntax) ---
import 'dotenv/config'; 
import { promises as fs } from 'fs';
import path from 'path';
import process from 'process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import Trello from 'trello'; 
import Groq from 'groq-sdk';
import { fetch } from 'undici'; 

// --- Settings and Constants ---
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify' 
];
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

// --- Load ALL Environment Variables ---
const {
    TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_SENT_CV_LIST_ID,
    TRELLO_ESTABLISHED_CONTACT_LIST_ID,
    TRELLO_INITIAL_INTERVIEW_LIST_ID,
    TRELLO_CODING_INTERVIEW_LIST_ID,
    TRELLO_ARCHITECTURE_INTERVIEW_LIST_ID, 
    TRELLO_MANAGEMENT_AND_HR_LIST_ID, 
    TRELLO_DROPPED_INITIAL_LIST_ID,      
    GROQ_API_KEY,
    NTFY_TOPIC, // <-- Notification topic
    MY_EMAIL 
} = process.env;

// --- AI Model Setup ---
const aiModelName = "llama-3.1-8b-instant";
let groq;

if (!GROQ_API_KEY) {
    console.error("❌ Error: GROQ_API_KEY not found in .env file. AI classification disabled.");
} else {
    groq = new Groq();
    console.log(`🤖 Groq AI Client initialized with model "${aiModelName}".`);
}

// --- Gmail Authentication Functions: saveCredentials, authorize ---
async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  let scope_string = '';
  if (Array.isArray(client.credentials.scope)) { scope_string = client.credentials.scope.join(' '); }
  else if (typeof client.credentials.scope === 'string') { scope_string = client.credentials.scope; }
  const payload = JSON.stringify({
    type: 'authorized_user', client_id: key.client_id, client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token, scope: scope_string, 
  });
  await fs.writeFile(TOKEN_PATH, payload);
  console.log(`✅ Token saved to ${TOKEN_PATH}`);
}
async function authorize() {
  let savedCredentials;
  try {
    const content = await fs.readFile(TOKEN_PATH);
    savedCredentials = JSON.parse(content);
  } catch (err) { savedCredentials = null; }
  const savedScopes = savedCredentials?.scope?.split(' ') || [];
  if (savedCredentials && SCOPES.every(scope => savedScopes.includes(scope))) {
      console.log("✅ Re-using saved Google token.");
      return google.auth.fromJSON(savedCredentials); 
  }
  console.log("Scopes missing or token invalid. Forcing re-authentication...");
  try { await fs.unlink(TOKEN_PATH); } catch (e) { /* ignore */ } 
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials) { await saveCredentials(client); }
  return client;
}
async function markEmailAsRead(gmail, messageId) {
    try {
        await gmail.users.messages.modify({ userId: 'me', id: messageId, resource: { removeLabelIds: ['UNREAD'] } });
        console.log(`    - Marked email ${messageId} as read.`);
    } catch (error) { console.error(`    - Failed to mark email ${messageId} as read:`, error.message); }
}

// --- AI Classification Function: classifyEmailWithAI  ---
async function classifyEmailWithAI(subject, snippet) {
    if (!groq) { 
        console.log("    - AI classification skipped (client not initialized).");
        return "OTHER_REPLY"; 
    }
    const emailText = `Subject: ${subject}\nSnippet: ${snippet}`;
    const categories = [ "INITIAL_INTERVIEW", "CODING_CHALLENGE", "TECHNICAL_INTERVIEW", "HR_INTERVIEW", "REJECTION", "OFFER", "OTHER_REPLY" ];
    const systemPrompt = `You are an expert email classifier for a job application tracker. Classify the email into ONE of the following categories: ${categories.join(", ")}. Respond ONLY with the single category name.`;
    const userPrompt = `Classify this email:\n---\n${emailText}\n---`;
    try {
        console.log(`    - Asking Groq AI (${aiModelName}) to classify email...`);
        const response = await groq.chat.completions.create({
            model: aiModelName, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0,
        });
        const classification = response.choices[0].message.content.trim().toUpperCase();
        if (categories.includes(classification)) {
             console.log(`    - AI Classification: ${classification}`);
             return classification;
        } else {
             console.warn(`    - AI returned an unexpected classification: "${classification}". Defaulting to OTHER_REPLY.`);
             return "OTHER_REPLY";
        }
    } catch (error) {
        console.error(`    - ❌ Error calling Groq API:`, error.message);
        return "OTHER_REPLY"; 
    }
}

// --- Notification Function ---
async function sendNotification(title, message) {
    if (!NTFY_TOPIC) {
        console.log("   - Notification skipped (NTFY_TOPIC not set in .env).");
        return;
    }
    try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
            method: 'POST',
            body: message, // Just the plain text message
            headers: {
                'Title': title, // Plain text title
                'Priority': 'default',
                'Tags': 'robot' // Use a simple tag
            }
        });
        console.log("✅ Notification sent successfully.");
    } catch (error) {
        console.error("    - ❌ Error sending notification:", error.message);
    }
}



 // Main function to run the logic
 
async function main() {
    
    const yourEmailAddress = MY_EMAIL; 
    let notificationTitle = ""; 
    let notificationMessage = ""; 
    
    // --- Step 1: Authenticate and Connect ---
    console.log("Connecting to Gmail...");
    let gmail;
    try {
        const auth = await authorize(); 
        gmail = google.gmail({ version: 'v1', auth });
        console.log("Gmail connection successful.");
    } catch (gmailError) {
        console.error("❌ Failed to connect to Gmail:", gmailError.message);
        await sendNotification("Trello Bot Error", "Failed to connect to Gmail: " + gmailError.message);
        return;
    }
    console.log("Connecting to Trello...");
    if (!TRELLO_API_KEY || !TRELLO_TOKEN || !TRELLO_SENT_CV_LIST_ID) {
        console.error("❌ Error: Ensure TRELLO_API_KEY, TRELLO_TOKEN, and TRELLO_SENT_CV_LIST_ID are set in .env");
        await sendNotification("Trello Bot Error", "Trello environment variables are missing.");
        return;
    }
    const trello = new Trello(TRELLO_API_KEY, TRELLO_TOKEN);
    console.log("Trello connection successful.");
    console.log("---\n");

    // --- Step 2: Get Data ---
    console.log(`Fetching Trello cards from 'Sent CV' list (${TRELLO_SENT_CV_LIST_ID})...`);
    let trelloCards;
    try {
        trelloCards = await trello.makeRequest('get', `/1/lists/${TRELLO_SENT_CV_LIST_ID}/cards`);
        console.log(`✅ Found ${trelloCards.length} cards in 'Sent CV'.`);
    } catch (err) {
        console.error("❌ Error getting Trello cards:", err.message);
        await sendNotification("Trello Bot Error", "Failed to fetch Trello cards: " + err.message);
        return;
    }
    console.log("\nFetching UNREAD emails from Gmail...");
    let messages;
    try {
        const res = await gmail.users.messages.list({
            userId: 'me', maxResults: 20, q: 'is:inbox is:unread'
        });
        messages = res.data.messages || [];
    } catch (listError) {
        console.error("❌ Error fetching email list from Gmail:", listError.message);
        await sendNotification("Trello Bot Error", "Failed to fetch Gmail list: " + listError.message);
        return;
    }

    if (messages.length === 0) {
        console.log('✅ No unread emails found in inbox.');
        console.log("\n--- End of run ---");
        return;
    }
    console.log(`Found ${messages.length} unread emails. Analyzing...`);

    // --- Step 3: Process, Match, and Update ---
    let movedCardsLog = []; 
    let cardsFailed = 0;

    for (const message of messages) {
        let msg;
        try {
            msg = await gmail.users.messages.get({ 
                userId: 'me', id: message.id, format: 'metadata', 
                metadataHeaders: ['From', 'Subject', 'To'] 
            });
        } catch (getError) {
            console.error(`\n❌ Error fetching details for email ID ${message.id}:`, getError.message);
            continue;
        }

        const headers = msg.data.payload.headers;
        const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        const toHeader = headers.find(h => h.name.toLowerCase() === 'to')?.value || '';
        const snippet = msg.data.snippet || '';
        const emailTimestamp = parseInt(msg.data.internalDate, 10);
        const formattedDate = new Date(emailTimestamp).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }); 

        if (!toHeader.toLowerCase().includes(yourEmailAddress.toLowerCase())) {
            console.log(`\n- Skipping email "${subject}" (Not directly addressed to you).`);
            continue;
        }

        const fromEmail = fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader.trim();
        console.log(`\n- Analyzing email: "${subject}"`);
        console.log(`  - From: ${fromEmail}`);
        console.log(`  - Date: ${formattedDate}`); 
        
        const emailThreadId = msg.data.threadId;
        const domain = fromEmail.includes('@') ? fromEmail.split('@')[1].toLowerCase() : null;
        let matchingCard = null;
        let matchMethod = "";

        if (emailThreadId) {
            const threadIdToMatch = `threadId: ${emailThreadId}`;
            matchingCard = trelloCards.find(card => card.desc && card.desc.includes(threadIdToMatch));
            if(matchingCard) matchMethod = "Thread ID";
        }
        if (!matchingCard && domain) {
            console.log(`    - No Thread ID match. Trying domain: "${domain}"...`);
            const escapedDomain = domain.replace(/\./g, '\\.'); 
            const domainRegex = new RegExp(`domain:\\s*(${escapedDomain}|\\[${escapedDomain}\\])`, 'i');
            matchingCard = trelloCards.find(card => card.desc && domainRegex.test(card.desc));
            if(matchingCard) matchMethod = "Domain";
        }

        if (matchingCard) {
            console.log(`    ✅ Found matching Trello card by ${matchMethod}: "${matchingCard.name}"`);
            const classificationLabel = await classifyEmailWithAI(subject, snippet);
            let targetListId = null;
            let targetListName = "Unknown List";

            switch (classificationLabel) {
                case 'INITIAL_INTERVIEW': targetListId = TRELLO_INITIAL_INTERVIEW_LIST_ID; targetListName = "Initial Interview"; break;
                case 'CODING_CHALLENGE': targetListId = TRELLO_CODING_INTERVIEW_LIST_ID; targetListName = "Coding Interview"; break;
                case 'TECHNICAL_INTERVIEW': targetListId = TRELLO_ARCHITECTURE_INTERVIEW_LIST_ID; targetListName = "Architecture Interview"; break;
                case 'HR_INTERVIEW': targetListId = TRELLO_MANAGEMENT_AND_HR_LIST_ID; targetListName = "Management and HR"; break;
                case 'REJECTION': targetListId = TRELLO_DROPPED_INITIAL_LIST_ID; targetListName = "Dropped Initial"; break;
                case 'OTHER_REPLY': targetListId = TRELLO_ESTABLISHED_CONTACT_LIST_ID; targetListName = "Established Contact"; break;
                case 'OFFER': console.log("    - AI classified as OFFER. No list ID configured."); break;
                default: console.log(`    - Unknown classification: ${classificationLabel}. Card will not be moved.`);
            }

            if (targetListId) {
                console.log(`    - Attempting to move card to "${targetListName}" list...`);
                try {
                    await trello.makeRequest('put', `/1/cards/${matchingCard.id}`, { idList: targetListId });
                    console.log(`    ✅ Successfully moved card.`);
                    movedCardsLog.push({ name: matchingCard.name, list: targetListName, subject: subject });
                    await markEmailAsRead(gmail, message.id);
                    trelloCards = trelloCards.filter(card => card.id !== matchingCard.id);
                } catch (moveError) {
                    console.error(`    ❌ Error moving card ${matchingCard.id}:`, moveError.message);
                    cardsFailed++;
                }
            } else {
                console.log(`    - No action defined for classification "${classificationLabel}". Email remains unread.`);
            }
        } else {
            console.log(`    - No matching Trello card found (by Thread ID or Domain) in the 'Sent CV' list.`);
        }
    } 

    console.log("\n--- Summary ---");
    console.log(`Processed ${messages.length} unread emails.`);
    console.log(`Moved ${movedCardsLog.length} Trello cards.`); 
    if (cardsFailed > 0) console.log(`Failed to move ${cardsFailed} cards.`);
    console.log("--- End of run ---");

    // --- Send plain text notification ---
    if (messages.length > 0) {
        let notificationTitle = "Trello Bot: All Clear";
        let notificationMessage = `Processed ${messages.length} unread emails. No new actions taken.`;

        if (movedCardsLog.length > 0) {
            notificationTitle = `Trello Bot: ${movedCardsLog.length} Card(s) Moved`;
            
            const logEntries = movedCardsLog.map(log => {
                const shortSubject = log.subject.length > 30 ? log.subject.substring(0, 27) + "..." : log.subject;
                return `- ${log.name} -> ${log.list} (from: "${shortSubject}")`;
            });
            
            notificationMessage = `Moved ${movedCardsLog.length} card(s):\n${logEntries.join('\n')}`;
        }
        
        await sendNotification(notificationTitle, notificationMessage);
    }
}

// --- Run Main Function ---
main().catch(async (error) => {
    console.error("\n--- Critical Error ---");
    console.error("An unhandled error occurred:", error.message);
    console.error(error.stack);
    await sendNotification("Trello Bot: CRITICAL ERROR", `Script crashed: ${error.message}`);
    process.exit(1);
});

