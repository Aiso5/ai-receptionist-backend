// ai-receptionist-backend/index.js
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const bodyParser = require('body-parser');
const fs      = require('fs');
const twilio  = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(express.json());

// ─── ENV ───────────────────────────────────────────────────────────────
const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_API_KEY,
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
  if (mod==='PM' && h!==12) h+=12;
  if (mod==='AM' && h===12) h=0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function getTomorrowRange(){
  const s=new Date(); s.setDate(s.getDate()+1); s.setHours(0,0,0,0);
  const e=new Date(s); e.setHours(23,59,59,999);
  return { startMs:s.getTime(), endMs:e.getTime() };
}
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── 1) BOOK APPOINTMENT ───────────────────────────────────────────────
app.post('/check-and-book', async (req,res)=>{
  try{
    let { name, phone, date, time, service } = req.body;
    if(!service) return res.status(400).json({status:'fail',message:'Missing service'});
    service=service.trim();
    const calendarId = SERVICE_CAL_IDS[service];
    if(!calendarId) return res.status(400).json({status:'fail',message:`Unknown service: ${service}`});

    // validate
    const dateRe=/^\\d{4}-\\d{2}-\\d{2}$/, timeRe=/^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if(!name||!phone||!date||!time) return res.status(400).json({status:'fail',message:'Missing fields'});
    if(!dateRe.test(date)) return res.status(400).json({status:'fail',message:'Date must be YYYY-MM-DD'});
    if(!timeRe.test(time)) return res.status(400).json({status:'fail',message:'Time must be H:MM AM/PM'});

    // ISO timestamps
    const [h24,min]=to24h(time).split(':');
    const startISO=`${date}T${h24}:${min}:00-05:00`;
    const endISO=new Date(new Date(startISO).getTime()+30*60*1000)
                  .toISOString().replace('.000Z','-05:00');

    // payload
    const payload={
      calendarId,
      meetingLocationType:"custom",
      meetingLocationId:"default",
      appointmentStatus:"new",
      name,
      phone,
      startTime:startISO,
      endTime:endISO,
      ignoreFreeSlotValidation:true
    };

    const { data } = await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      payload,
      { headers:{Authorization:`Bearer ${GHL_API_KEY}`}}
    );
    res.json({status:'success', id:data.id});
  }catch(err){
    console.error('Booking error:',err.response?.data||err);
    res.status(500).json({status:'error',message:'Booking failed.'});
  }
});

// ─── 2) SEND REMINDERS ─────────────────────────────────────────────────
app.post('/send-reminders', async (req,res)=>{
  const hr=new Date().getHours();
  if(hr<9||hr>=18) return res.status(429).send('Outside call window');
  try{
    const {startMs,endMs}=getTomorrowRange();
    const all=[];
    for(const calId of Object.values(SERVICE_CAL_IDS)){
      const {data}=await axios.get(
        'https://rest.gohighlevel.com/v1/appointments/',
        { headers:{Authorization:`Bearer ${GHL_API_KEY}`},
          params:{startDate:startMs,endDate:endMs,calendarId:calId,includeAll:true}}
      );
      all.push(...(data.appointments||[]));
    }
    for(const a of all){
      if(!['new','booked','confirmed'].includes(a.status)) continue;
      const phone=a.contact?.phone||a.phone; if(!phone) continue;
      const when=new Date(a.startTime)
                 .toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
      const task=`Hi ${a.title||'patient'}, this is Mia confirming your ${a.title} tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;
      await axios.post('https://api.bland.ai/v1/calls',
        { phone_number:phone, voice:'June', task,
          callback_url:`${BASE_URL}/handle-confirmation?appointmentId=${a.id}`,
          status_callback:`${BASE_URL}/call-status`
        },
        { headers:{Authorization:`Bearer ${BLAND_API_KEY}`}}
      );
      fs.appendFileSync('call-log.json',
        JSON.stringify({ts:new Date().toISOString(),event:'call-sent',phone})+'\\n');
    }
    res.send('Outbound calls scheduled.');
  }catch(err){
    console.error('Reminder error:',err.response?.data||err);
    res.status(500).send('Failed to send reminders');
  }
});

// ─── 3) HANDLE CONFIRMATION ────────────────────────────────────────────
app.post('/handle-confirmation', async (req,res)=>{
  try{
    const id=req.query.appointmentId;
    if(!id) return res.status(400).send('Missing appointmentId');
    const resp=(req.body.confirmation||'').trim().toLowerCase();
    const status=resp==='yes'?'confirmed':'cancelled';
    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${id}/status`,
      {status},
      {headers:{Authorization:`Bearer ${GHL_API_KEY}`}}
    );
    res.sendStatus(200);
  }catch(err){
    console.error('Confirmation error:',err.response?.data||err);
    res.status(500).send('Confirmation handling failed');
  }
});

// ─── 4) CALL-STATUS → SMS FALLBACK ─────────────────────────────────────
app.post('/call-status',async(req,res)=>{
  const {status,phone_number}=req.body;
  try{
    if(['no-answer','busy'].includes(status)){
      await twilioClient.messages.create({
        from:TWILIO_PHONE_NUMBER,
        to:phone_number,
        body:'We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.'
      });
    }
    res.sendStatus(200);
  }catch(err){
    console.error('Call-status error:',err);
    res.status(500).send('Call status processing failed');
  }
});

// ─── START SERVER ──────────────────────────────────────────────────────
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Server running on ${PORT}`));
