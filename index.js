// ai-receptionist-backend/index.js
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const bodyParser = require('body-parser');
const twilioLib  = require('twilio');
const fs         = require('fs');

const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(express.json());

// ─── ENV ─────────────────────────────────────────────────────────────
const {
  BLAND_API_KEY,
  BASE_URL,            // https://ai-receptionist-backend-....onrender.com
  GHL_OAUTH_TOKEN,     // your Private Integration token
  GHL_LOCATION_ID,     // your sub‑account Location ID
  GHL_ASSIGNED_USER_ID,// staff User ID
  GHL_API_KEY,         // v1 key for contacts
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

// ─── V2 BASE ─────────────────────────────────────────────────────────
const GHL_V2 = 'https://api.leadconnectorhq.com';

// ─── SERVICE → CALENDAR MAP ───────────────────────────────────────────
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

// ─── HELPERS ──────────────────────────────────────────────────────────
function to24h(t12) {
  const [t,mod]=t12.split(' ');
  let [h,m]=t.split(':').map(Number);
  if(mod==='PM'&&h!==12) h+=12;
  if(mod==='AM'&&h===12) h=0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
async function ensureContact(phone,name) {
  // v1 lookup
  let r = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{Authorization:`Bearer ${GHL_API_KEY}`}, params:{phone} }
  );
  if(r.data.contacts?.length) return r.data.contacts[0].id;
  // create then re-fetch
  await axios.post(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { phone,name },
    { headers:{Authorization:`Bearer ${GHL_API_KEY}`} }
  );
  r = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{Authorization:`Bearer ${GHL_API_KEY}`}, params:{phone} }
  );
  return r.data.contacts[0].id;
}
function getTomorrowRange() {
  const s=new Date(), e=new Date();
  s.setDate(s.getDate()+1); s.setHours(0,0,0,0);
  e.setDate(s.getDate());    e.setHours(23,59,59,999);
  return { startMs:s.getTime(), endMs:e.getTime() };
}
const twilio = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── HEALTHCHECK ─────────────────────────────────────────────────────
app.get('/health',(req,res)=>res.send('OK'));

// ─── 1) BOOK APPT (API v2) ─────────────────────────────────────────────
app.post('/check-and-book', async (req,res) => {
  try {
    let { name,phone,date,time,service } = req.body;
    if(!service) return res.status(400).json({status:'fail',message:'Missing service.'});
    const calId = SERVICE_CAL_IDS[service.trim()];
    if(!calId) return res.status(400).json({status:'fail',message:`Unknown service: ${service}`});

    // normalize
    date = Array.isArray(date)? date.join(''): (date||'').trim();
    time = Array.isArray(time)? time.join(''): (time||'').trim();

    // validate
    const dRe=/^\d{4}-\d{2}-\d{2}$/, tRe=/^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if(!name||!phone||!date||!time) {
      return res.status(400).json({status:'fail',message:'Missing fields.'});
    }
    if(!dRe.test(date)) {
      return res.status(400).json({status:'fail',message:'Date must be YYYY-MM-DD'});
    }
    if(!tRe.test(time)) {
      return res.status(400).json({status:'fail',message:'Time must be H:MM AM/PM'});
    }

    // build ISO
    const [h24,min]=to24h(time).split(':');
    const startISO=`${date}T${h24}:${min}:00-05:00`;
    const endISO=new Date(new Date(startISO).getTime()+30*60000)
                   .toISOString().replace('.000Z','-05:00');

    // ensure contact
    const contactId = await ensureContact(phone,name);

    // payload
    const payload = {
      title:                   `${service} – ${name}`,
      meetingLocationType:     "custom",
      meetingLocationId:       "default",
      overrideLocationConfig:  true,
      appointmentStatus:       "new",
      assignedUserId:          GHL_ASSIGNED_USER_ID,
      address:                 phone,
      ignoreDateRange:         false,
      toNotify:                false,
      ignoreFreeSlotValidation:true,
      calendarId:              calId,
      locationId:              GHL_LOCATION_ID,
      contactId,
      startTime:               startISO,
      endTime:                 endISO
    };

    console.log('👉 v2 payload:', payload);

    const out = await axios.post(
      `${GHL_V2}/calendars/events/appointments`,
      payload,
      {
        headers:{
          Authorization: `Bearer ${GHL_OAUTH_TOKEN}`,
          Version:        '2021-04-15',
          'Content-Type':'application/json'
        }
      }
    );

    console.log('✅ created:', out.data);
    res.json({status:'success',id:out.data.id});
  } catch(err) {
    console.error('Booking error:', err.response?.data||err);
    res.status(500).json({status:'error',message:'Booking failed.'});
  }
});

// ─── 2) SEND REMINDERS ─────────────────────────────────────────────────
app.post('/send-reminders', async (req,res)=>{
  const hr=new Date().getHours();
  if(hr<9||hr>=18) return res.status(429).send('Outside call window');
  try {
    const {startMs,endMs}=getTomorrowRange();
    const calls=[];

    // grab from each service calendar
    for(const calId of Object.values(SERVICE_CAL_IDS)) {
      const r = await axios.get(
        `${GHL_V2}/calendars/events/appointments`,
        {
          headers:{
            Authorization: `Bearer ${GHL_OAUTH_TOKEN}`,
            Version:        '2021-04-15'
          },
          params:{ calendarId:calId, startTime:startMs, endTime:endMs }
        }
      );
      calls.push(...(r.data.appointments||[]));
    }

    for(const a of calls) {
      if(!['new','confirmed'].includes(a.appointmentStatus)) continue;
      const phone = a.contact?.phone||a.address;
      if(!phone) continue;
      const when = new Date(a.startTime)
                    .toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
      const task = `Hi ${a.title} patient, this is Mia confirming your ${a.title} tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;

      await axios.post(
        'https://api.bland.ai/v1/calls',
        {
          phone_number:   phone,
          voice:          'June',
          task,
          callback_url:   `${BASE_URL}/handle-confirmation?appointmentId=${a.id}`,
          status_callback:`${BASE_URL}/call-status`
        },
        { headers:{Authorization:`Bearer ${BLAND_API_KEY}`} }
      );

      fs.appendFileSync('call-log.json',
        JSON.stringify({ts:new Date().toISOString(),event:'call-sent',phone})+'\n'
      );
    }

    res.send('Outbound calls scheduled.');
  } catch(err) {
    console.error('Reminder error:',err.response?.data||err);
    res.status(500).send('Failed to send reminders');
  }
});

// ─── 3) HANDLE CONFIRMATION ────────────────────────────────────────────
app.post('/handle-confirmation', async (req,res)=>{
  try {
    const id = req.query.appointmentId;
    if(!id) return res.status(400).send('Missing appointmentId');
    const resp=(req.body.confirmation||'').trim().toLowerCase();
    const newStat = resp==='yes'? 'confirmed':'cancelled';

    await axios.put(
      `${GHL_V2}/calendars/events/appointments/${id}/status`,
      { status: newStat },
      {
        headers:{
          Authorization:`Bearer ${GHL_OAUTH_TOKEN}`,
          Version:       '2021-04-15',
          'Content-Type':'application/json'
        }
      }
    );
    res.sendStatus(200);
  } catch(err) {
    console.error('Confirmation error:', err.response?.data||err);
    res.status(500).send('Confirmation handling failed');
  }
});

// ─── 4) CALL-STATUS → SMS FALLBACK ─────────────────────────────────────
app.post('/call-status', async (req,res)=>{
  const {status,phone_number}=req.body;
  try {
    if(['no-answer','busy'].includes(status)) {
      await twilio.messages.create({
        from:TWILIO_PHONE_NUMBER,
        to:phone_number,
        body:'We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.'
      });
    }
    res.sendStatus(200);
  } catch(err) {
    console.error('Call-status error:',err);
    res.status(500).send('Call status processing failed');
  }
});

const PORT = process.env.PORT||10000;
app.listen(PORT,()=>console.log(`Server on port ${PORT}`));
