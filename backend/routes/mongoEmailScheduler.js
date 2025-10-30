import express from 'express';
import _ from 'lodash';
import cron from 'node-cron';

import { ScheduledEmail } from '../models/ScheduledEmail.js';
import { Subscription } from '../models/Subscription.js';
import { sendEmail } from '../sendEmail.js';

const router = express.Router();

/**
 * Starts the MongoEmailScheduler as a function.
 * Checks every minute for scheduled emails and processes them.
 */
function startMongoEmailScheduler() {
  cron.schedule('* * * * *', async () => {
    await processDueEmails();
  });
}

// Queries database for emails to send.
async function processDueEmails() {
  try {
    const now = new Date();
    const dueEmails = await ScheduledEmail.find({
      status: 'scheduled',
      nextRun: { $lte: now },
    });

    if (dueEmails.length > 0) {
      console.log(`📧 Found ${dueEmails.length} due emails to process`);
    }

    // Group emails by recipient and scheduled time (to the minute)
    const grouped = _.groupBy(
      dueEmails,
      (email) =>
        `${email.to}|${new Date(email.nextRun).toISOString().slice(0, 16)}`
    );

    for (const groupKey in grouped) {
      const group = grouped[groupKey];
      await processEmailGroup(group);
    }
  } catch (error) {
    console.error('❌ Error processing due emails:', error);
  }
}

// Helper function to process a group of emails
async function processEmailGroup(emailGroup) {
  if (emailGroup.length === 0) return;
  const recipient = emailGroup[0].to;

  // Combine subjects/texts
  const combinedSubject = `Your ${emailGroup.length} scheduled updates`;
  const combinedText = emailGroup
    .map(
      (email, idx) =>
        `#${idx + 1}\nSubject: ${email.subject}\n${email.text}\n`
    )
    .join('\n---\n');

  try {
    await sendEmail({
      to: recipient,
      subject: combinedSubject,
      text: combinedText,
    });

    for (const email of emailGroup) {
      if (email.isRecurring) {
        const nextRun = new Date(email.nextRun);
        nextRun.setMonth(nextRun.getMonth() + 1);
        email.nextRun = nextRun;
        email.lastSent = new Date();
      } else {
        email.status = 'sent';
      }
      await email.save();
    }
  } catch (error) {
    for (const email of emailGroup) {
      email.attempts += 1;
      email.errorMessage = error.message;
      if (email.attempts < 3) {
        email.nextRun = new Date(Date.now() + 5 * 60 * 1000);
      } else {
        email.status = 'failed';
      }
      await email.save();
    }
    console.error(
      `Failed to send combined email to ${recipient}:`,
      error.message
    );
  }
}

// Processes a single email
async function processEmail(email) {
  try {
    const subscription = await Subscription.findById(email.subscriptionId);

    if (!subscription || subscription.sendEmail === false) {
      email.status = 'skipped';
      await email.save();
      return;
    }

    await sendEmail({
      to: email.to,
      subject: email.subject,
      text: email.text,
    });

    if (email.isRecurring) {
      const nextRun = new Date(email.nextRun);
      nextRun.setMonth(nextRun.getMonth() + 1);
      email.nextRun = nextRun;
      email.lastSent = new Date();
    } else {
      email.status = 'sent';
    }

    await email.save();
  } catch (error) {
    email.attempts += 1;
    email.errorMessage = error.message;

    if (email.attempts < 3) {
      email.nextRun = new Date(Date.now() + 5 * 60 * 1000);
    } else {
      email.status = 'failed';
    }

    await email.save();
    console.error(`Failed to send email to ${email.to}:`, error.message);
  }
}

// Schedules a new email
async function scheduleEmail(emailData) {
  if (!emailData.sendEmail) {
    return null;
  }
  try {
    const { subscriptionId, to, subject, text, scheduledDateTime } = emailData;
    const scheduledDate = new Date(scheduledDateTime);

    const scheduledEmail = new ScheduledEmail({
      subscriptionId,
      to,
      subject,
      text,
      scheduledDateTime: scheduledDate,
      isRecurring: false,
      nextRun: scheduledDate,
      status: 'scheduled',
    });

    const savedEmail = await scheduledEmail.save();
    return savedEmail;
  } catch (error) {
    console.error('❌ Error scheduling email:', error);
    throw error;
  }
}

// Gets all scheduled (and sent) emails
async function getAllScheduledEmails() {
  try {
    return await ScheduledEmail.find({
      status: { $in: ['scheduled', 'sent'] },
    }).sort({ nextRun: 1 });
  } catch (error) {
    console.error('❌ Error fetching scheduled emails:', error);
    return [];
  }
}

// There is no need for a stop function in this stateless version.

// Express route to delete all scheduled emails for a given subscription
router.delete('/:id', async (req, res) => {
  await ScheduledEmail.deleteMany({ subscriptionId: req.params.id });
});

// Export the function to start the scheduler
export default startMongoEmailScheduler;
