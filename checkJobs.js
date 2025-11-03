import 'dotenv/config'; 
import Trello from 'trello'; 
import Groq from 'groq-sdk';
import { fetch } from 'undici'; 

// --- Load ALL Environment Variables ---
const {
    TRELLO_API_KEY, TRELLO_TOKEN, GROQ_API_KEY,
    // --- LIST TO CHECK ---
    TRELLO_SENT_CV_LIST_ID,
    // --- TARGET LIST ---
    TRELLO_JOB_DELETED_FROM_WEBSITE_LIST_ID,
    // --- NOTIFICATION TOPIC ---
    NTFY_TOPIC 
} = process.env;

// --- AI Model Setup ---
const aiModelName = "groq/compound"; // This model can browse the web
let groq;

let trello;

// ---  A simple delay function ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


  // Asks Groq AI to visit a URL and check if the job is active.

async function checkJobStatusWithAI(url) {
    if (!groq) {
        console.log("    - AI client not initialized. Skipping check.");
        return true; // Assume active to be safe
    }

    const systemPrompt = `You are a job status verifier. Your task is to check the provided URL and determine if the job posting is "ACTIVE" or "DELETED". 
A job is "DELETED" if the page is a 404, says "job not found", "position filled", "no longer available", or redirects to a generic careers page.
A job is "ACTIVE" if the posting is still visible and seems to be accepting applications.
Respond ONLY with the single word 'ACTIVE' or 'DELETED'.`;
    
    const userPrompt = `Please check this URL and report its status: ${url}`;

    try {
        console.log(`    - Asking Groq AI to check URL: ${url}`);
        const response = await groq.chat.completions.create({
            "messages": [
                {"role": "system", "content": systemPrompt},
                {"role": "user", "content": userPrompt}
            ],
            "model": aiModelName, 
            "temperature": 0,
            "compound_custom": {
                "tools": { "enabled_tools": ["web_search"] } // Enable web browsing
            }
        });

        const classification = response.choices[0].message.content.trim().toUpperCase();
        
        if (classification === 'ACTIVE') {
            console.log("    - AI Status: ACTIVE");
            return true;
        } else if (classification === 'DELETED') {
            console.log("    - AI Status: DELETED");
            return false;
        } else {
            console.warn(`    - AI returned unexpected status: "${classification}". Assuming ACTIVE to be safe.`);
            return true; 
        }

    } catch (error) {
        console.error(`    - ❌ Error checking job status with AI:`, error.message);
        return true; // Assume active to be safe if AI fails
    }
}


 // Sends a notification to your phone via ntfy.sh
 
async function sendNotification(title, message) {
    if (!NTFY_TOPIC) {
        console.log("   - Notification skipped (NTFY_TOPIC not set in .env).");
        return;
    }
    try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
            method: 'POST',
            body: message,
            headers: {
                'Title': title,
                'Priority': 'default',
                'Tags': 'broom,robot' 
            }
        });
        console.log("✅ Notification sent successfully.");
    } catch (error) {
        console.error("    - ❌ Error sending notification:", error.message);
    }
}


// Main function to run the logic
 
async function main() {
    console.log("--- Starting Job Status Checker Script ---");
    let notificationTitle = "Trello Job Checker";
    let notificationMessage = "";

    // --- 1. Check Config ---
    if (!TRELLO_API_KEY || !TRELLO_TOKEN || !GROQ_API_KEY || !TRELLO_JOB_DELETED_FROM_WEBSITE_LIST_ID || !TRELLO_SENT_CV_LIST_ID) {
        console.error("❌ Error: One or more required environment variables are missing.");
        console.error("   (Check TRELLO_API_KEY, TRELLO_TOKEN, GROQ_API_KEY, TRELLO_SENT_CV_LIST_ID, TRELLO_JOB_DELETED_FROM_WEBSITE_LIST_ID)");
        await sendNotification("Job Checker Error", "Required .env variables are missing.");
        return;
    }
    
    trello = new Trello(TRELLO_API_KEY, TRELLO_TOKEN);
    groq = new Groq();

    // --- 2. Define List to Scan ---
    const listToScanId = TRELLO_SENT_CV_LIST_ID;
    console.log(`Scanning "Sent CV" list (ID: ${listToScanId}) for active jobs...`);

    let allActiveCards = [];
    let cardsMoved = 0;
    // --- Array to store names of deleted jobs ---
    let deletedJobNames = [];

    // --- 3. Fetch All Cards from the "Sent CV" List ---
    try {
        allActiveCards = await trello.makeRequest('get', `/1/lists/${listToScanId}/cards`);
    } catch (err) {
        console.error("❌ Error fetching Trello cards:", err.message);
        await sendNotification("Job Checker Error", "Failed to fetch Trello cards: " + err.message);
        return;
    }

    console.log(`✅ Found ${allActiveCards.length} total cards to check.`);
    if (allActiveCards.length === 0) {
        console.log("No cards to check. Exiting.");
        return; 
    }

    // --- 4. Process Each Card ---
    for (const card of allActiveCards) {
        console.log(`\nChecking card: "${card.name}" (ID: ${card.id})`);

        // --- Attachment Logic ---
        let jobUrl = null;
        try {
            const attachments = await trello.makeRequest('get', `/1/cards/${card.id}/attachments`);
            const linkAttachment = attachments.find(att => att.isUpload === false && att.url);
            
            if (linkAttachment) {
                jobUrl = linkAttachment.url;
            } else {
                console.log("    - No link attachment found. Skipping.");
                continue; 
            }
            
        } catch (attError) {
            console.error("    - ❌ Error fetching attachments:", attError.message);
            continue; 
        }
        // --- End of Attachment Logic ---
        
        const isJobActive = await checkJobStatusWithAI(jobUrl);

        // 5. Move Card if Job is Deleted
        if (!isJobActive) {
            console.log(`    - Job is DELETED. Moving card to "Job Deleted" list...`);
            try {
                await trello.makeRequest('put', `/1/cards/${card.id}`, { 
                    idList: TRELLO_JOB_DELETED_FROM_WEBSITE_LIST_ID 
                });
                console.log("    - Card moved successfully.");
                cardsMoved++;
                // ---  Store the name of the moved card  ---
                deletedJobNames.push(card.name); 
            } catch (moveError) {
                console.error(`    - ❌ Error moving card:`, moveError.message);
            }
        } else {
            console.log("    - Job is still ACTIVE. Leaving card in place.");
        }

        console.log("    - Waiting 5 seconds before next check...");
        await delay(5000); 
    }

    // --- 6. Summary & Notification ---
    console.log("\n--- Summary ---");
    console.log(`Checked ${allActiveCards.length} cards.`);
    console.log(`Moved ${cardsMoved} deleted job cards.`);
    console.log("--- Job Status Check Complete ---");

    // ---  Build informative notification message  ---
    notificationMessage = `Checked ${allActiveCards.length} cards. All jobs are still active.`;
    if (cardsMoved > 0) {
        notificationTitle = `Trello Job Checker: ${cardsMoved} Job(s) Deleted`;
        // Create a bulleted list of job names
        notificationMessage = `Checked ${allActiveCards.length} cards and moved ${cardsMoved} deleted job(s):\n- ${deletedJobNames.join('\n- ')}`;
    }
    await sendNotification(notificationTitle, notificationMessage);
}

// --- Run Main Function ---
main().catch(async (error) => {
    console.error("\n--- Critical Error ---");
    console.error("An unhandled error occurred:", error.message);
    console.error(error.stack);
    await sendNotification("Job Checker: CRITICAL ERROR", `Script crashed: ${error.message}`);
    process.exit(1);
});

