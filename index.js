// ai-receptionist-backend/index.js (Now with full request logging)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const { MessagingResponse, VoiceResponse } = twilio.twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const SHEET_ID = '1KXQWB8cxNEgRrye0ShItZOWSpoQtlFw05qXoMrk-63Y';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const GOOGLE_SHEETS_CREDENTIALS = require('./google-credentials.json');

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_SHEETS_CREDENTIALS,
  scopes: SCOPES,
});

const BLAND_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NDU0NDIzMzgsInN1YiI6ImM1MDBhZGU3LTAyM2MtNGFkOC1hMGY0LWQ1OGQ3YTlmM2JiZCIsInVzZXJfaWQiOiJjNTAwYWRlNy0wMjNjLTRhZDgtYTBmNC1kNThkN2E5ZjNiYmQiLCJ1aWQiOiJjNTAwYWRlNy0wMjNjLTRhZDgtYTBmNC1kNThkN2E5ZjNiYmQiLCJpYXQiOjE3NDUwOTY3Mzh9.bSCoH-BhtqOmw1tPrwWEeV32Xw3gC5YLt8fltB8i7B0';

const BUSINESS_HOURS = {
  Monday: [10, 17],
  Tuesday: [16, 19],
  Wednesday: [10, 17],
  Thursday: [16, 19],
  Friday: [10, 14],
  Saturday: [10, 14],
  Sunday: null
};

function parseTimeTo24Hour(timeStr) {
  if (!timeStr) return null;
  const [time, modifier] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (modifier === 'PM' && hours !== 12) hours += 12;
  if (modifier === 'AM' && hours === 12) hours = 0;
  return hours + minutes / 60;
}

function isWithinBusinessHours(dateStr, timeStr) {
  const date = new Date(dateStr);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
  const hours = parseTimeTo24Hour(timeStr);
  const window = BUSINESS_HOURS[dayName];
  return window && hours !== null && hours >= window[0] && hours < window[1];
}

async function getAppointments() {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const range = 'Sheet1!A2:F';
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return result.data.values || [];
}

async function markReminderSent(rowIndex) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!F${rowIndex + 2}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Yes']] },
  });
}

app.post('/check-and-book', async (req, res) => {
  const { name, phone, date, time, service = "General" } = req.body;
  console.log("📥 Booking Request Received:", req.body);

  try {
    if (!date || !time || !name || !phone) {
      return res.status(400).json({ status: 'fail', message: 'Missing required fields.' });
    }

    if (!isWithinBusinessHours(date, time)) {
      return res.status(400).json({ status: 'fail', message: 'Outside business hours.' });
    }

    const existing = await getAppointments();
    const isBooked = existing.some(row => row[2] === date && row[3] === time);

    if (isBooked) {
      return res.status(409).json({ status: 'fail', message: 'Time slot already booked.' });
    }

    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[name, phone, date, time, service, 'No']]
      }
    });

    res.json({ status: 'success', message: 'Appointment booked.' });
  } catch (error) {
    console.error("❌ Error in booking:", error);
    res.status(500).json({ status: 'error', message: 'Something went wrong.' });
  }
});

app.post('/send-reminders', async (req, res) => {
  try {
    const appointments = await getAppointments();
    for (let i = 0; i < appointments.length; i++) {
      const [name, phone, date, time, service, sent] = appointments[i];
      if (!phone || sent?.toLowerCase() === 'yes') continue;

      await axios.post("https://api.bland.ai/v1/calls", {
        phone_number: phone,
        voice: "June",
        task: `You're Mia from My Vitality Med Spa. Call ${name} to confirm their ${service} appointment on ${date} at ${time}. Ask if they'll attend, and help them reschedule if needed. Be natural, warm, and friendly.`
      }, {
        headers: {
          Authorization: `Bearer ${BLAND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      await markReminderSent(i);
    }

    res.send("Bland AI reminders sent.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to send Bland AI reminders");
  }
});

app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say("Hi! Thanks for calling My Vitality Med Spa. I'm Mia, your virtual receptionist. Please leave a message.");
  twiml.record({ maxLength: 30, action: '/voice/recording' });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/recording', (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  console.log("Call recorded at:", recordingUrl);
  const twiml = new VoiceResponse();
  twiml.say("Thanks! We've saved your message.");
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/sms', (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.toLowerCase();

  if (incomingMsg.includes('appointment')) {
    twiml.message("You can book, reschedule, or cancel. Just reply with one of those words!");
  } else if (incomingMsg.includes('facial') || incomingMsg.includes('botox')) {
    twiml.message("We offer facials, Botox, microneedling, and more!");
  } else {
    twiml.message("Thanks for contacting My Vitality Med Spa. We'll get back to you soon.");
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
