// ai-receptionist-backend/index.js
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const bodyParser = require('body-parser');
const fs         = require('fs');
const twilioLib  = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ─── ENV ───────────────────────────────────────────────────────────────
const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_OAUTH_TOKEN,       // v2 API Bearer token from Private Integrations
  GHL_LOCATION_ID,       // your sub-account’s Location ID
  GHL_ASSIGNED_USER_ID,  // the staff User ID to assign appointments
  GHL_API_KEY,           // v1 API key for contacts
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

// ─── SERVICE → CALENDAR MAP ────────────────────────────────────────────
const SERVICE_CAL_IDS = {
  "Microneedling":        "CVV5l5hW8oQj9fCvJRQ0",
  "Hydrafacial":          "I9kLB4y6IA6gjSRhoPkE",
  "IPL Acne Treatments":  "LsUJFSftNp3F7WPgX4mZ",
  "Press Files":          "Xo5vCcfx6bWIVykhPbsH",
  "Body Contouring":      "atRqPW5SeTiOXwDx8VZx",
  "PRP Injections":       "hm9zPDrD0kh86uVaZDwW",
  "Laser Hair Removal":   "nddmesx61WaFpfrQR3ut",
  "Fillers":              "xdyndm4rMsTvh48CLRjd",
  "Body Multi Shape":     "fcs6WN0rroebbG97bitr",
  "Laser Treatments":     "ztEI8IyOTmJL7uFzRgCu"
};

// ─── HELPERS ───────────────────────────────────────────────────────────
function to24h(t12) {
  const [t, mod] = t12.split(' ');
  let [h,m] = t.split(':').map(Number);
  if (mod === 'PM' && h !== 12) h += 12;
  if (mod === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function getTomorrowRange() {
  const start = new Date(), end = new Date();
  start.setDate(start.getDate()+1);
  start.setHours(0,0,0,0);
  end.setDate(start.getDate());
  end.setHours(23,59,59,999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── HEALTHCHECK ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.send('OK'));

// ─── CONTACT LOOKUP/CREATE (v1) ───────────────────────────────────────
async function ensureContact(phone,name) {
  // Try fetch existing contact
  let res = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{ Authorization:`Bearer ${GHL_API_KEY}` }, params:{ phone } }
  );
  if (res.data.contacts?.length) {
    return res.data.contacts[0].id;
  }
  // Create then re-fetch
  await axios.post(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { phone, name },
    { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
  );
  res = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{ Authorization:`Bearer ${GHL_API_KEY}` }, params:{ phone } }
  );
  return res.data.contacts[0].id;
}

// ─── 1) BOOK APPOINTMENT (v2) ─────────────────────────────────────────
app.post('/check-and-book', async (req, res) => {
  try {
    let { name, phone, date, time, service } = req.body;
    if (!service) return res.status(400).json({status:'fail',message:'Missing service'});
    service = service.trim();
    const calendarId = SERVICE_CAL_IDS[service];
    if (!calendarId) return res.status(400).json({status:'fail',message:`Unknown service: ${service}`});

    // Normalize & validate
    date = Array.isArray(date)? date.join(''): date.trim();
    time = Array.isArray(time)? time.join(''): time.trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!name||!phone||!date||!time) {
      return res.status(400).json({status:'fail',message:'Missing fields'});
    }
    if (!dateRe.test(date)) {
      return res.status(400).json({status:'fail',message:'Date must be YYYY-MM-DD'});
    }
    if (!timeRe.test(time)) {
      return res.status(400).json({status:'fail',message:'Time must be H:MM AM/PM'});
    }

    // Build ISO slot
    const [h24,min] = to24h(time).split(':');
    const startISO   = `${date}T${h24}:${min}:00-05:00`;
    const endISO     = new Date(new Date(startISO).getTime() + 30*60*1000)
                         .toISOString().replace('.000Z','-05:00');

    // Ensure contact exists
    const contactId = await ensureContact(phone,name);

    // Build v2 payload
    const payload = {
      title:                    `${service} – ${name}`,
      meetingLocationType:      "custom",
      meetingLocationId:        "default",
      overrideLocationConfig:   true,
      appointmentStatus:        "new",
      assignedUserId:           GHL_ASSIGNED_USER_ID,
      address:                  phone,
      ignoreDateRange:          false,
      toNotify:                 false,
      ignoreFreeSlotValidation: true,
      calendarId,
      locationId:               GHL_LOCATION_ID,
      contactId,
      startTime:                startISO,
      endTime:                  endISO
    };

    console.log('Booking payload:', payload);

    // Call v2 endpoint
    const createRes = await axios.post(
      'https://services.leadconnectorhq.com/calendars/events/appointments',
      payload,
      {
        headers: {
          Authorization: `Bearer ${GHL_OAUTH_TOKEN}`,
          Version:        '2021-04-15',
          'Content-Type':'application/json'
        }
      }
    );

    console.log('Created appointment:', createRes.data);
    return res.json({ status:'success', id:createRes.data.id });

  } catch (err) {
    console.error('Booking error:', err.response?.data || err);
    return res.status(500).json({status:'error',message:'Booking failed.'});
  }
});

// ─── 2) SEND REMINDERS & 3) HANDLE CONFIRMATIONS & 4) CALL-STATUS ─────
// (Reuse your existing routes for send-reminders, handle-confirmation, call-status,
//  which call Bland & Twilio as before. They don’t change.)

// ─── START SERVER ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`Server running on port ${PORT}`));
