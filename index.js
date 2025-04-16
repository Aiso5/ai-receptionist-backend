// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const { MessagingResponse, VoiceResponse } = twilio.twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

// Inbound voice
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say("Hi! Thanks for calling My Vitality Med Spa. I'm Mia, your virtual receptionist. How can I assist you today?");
  twiml.pause({ length: 2 });
  twiml.say("Please leave a message after the tone.");
  twiml.record({ maxLength: 30, action: '/voice/recording' });
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle recording
app.post('/voice/recording', (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  console.log("Call recorded at:", recordingUrl);
  const twiml = new VoiceResponse();
  twiml.say("Thanks! We've saved your message.");
  res.type('text/xml');
  res.send(twiml.toString());
});

// SMS
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

// GHL placeholder
app.get('/test-gohighlevel', async (req, res) => {
  try {
    const response = await axios.get('https://rest.gohighlevel.com/v1/contacts', {
      headers: { Authorization: `Bearer ${process.env.GOHIGHLEVEL_API_KEY}` }
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Error contacting GoHighLevel');
  }
});

// Outbound reminder
app.post('/send-reminders', async (req, res) => {
  const { phoneNumber, name, time } = req.body;
  try {
    await twilioClient.calls.create({
      twiml: `<Response><Say>Hello ${name}, this is a reminder from My Vitality Med Spa for your appointment at ${time}.</Say></Response>`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    await twilioClient.messages.create({
      body: `Hi ${name}, this is My Vitality Med Spa reminding you of your appointment at ${time}.`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    res.send("Reminder sent.");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Failed to send reminder.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
