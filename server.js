const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const slugify = require("slugify");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-secret-change-me";
const usingPostgres = Boolean(DATABASE_URL);

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

["uploads","uploads/logos","uploads/banners","uploads/posters","uploads/archive","uploads/temp"].forEach(d=>{
  fs.mkdirSync(path.join(__dirname,d), { recursive:true });
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(rateLimit({ windowMs: 60*1000, limit: 240, standardHeaders:true, legacyHeaders:false }));

let pool = null;
if (usingPostgres) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized:false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

const PgSession = usingPostgres ? require("connect-pg-simple")(session) : null;
app.use(session({
  store: usingPostgres ? new PgSession({ pool, createTableIfMissing: true }) : undefined,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const memory = { libraries:[], users:[], events:[], applications:[], games:[], archive_photos:[], announcements:[], surveys:[] };

async function db(sql, params=[]) {
  if (!usingPostgres) throw new Error("PostgreSQL aktif değil");
  const r = await pool.query(sql, params);
  return r.rows;
}
async function one(sql, params=[]) { const rows = await db(sql, params); return rows[0]; }
async function hash(p){ return bcrypt.hash(p,10); }
async function cmp(p,h){ return bcrypt.compare(p,h); }
function esc(s){ return String(s||"").trim(); }
function slug(s){ return slugify(esc(s), { lower:true, strict:true, locale:"tr" }); }
function fdate(n){ const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function rank(score){ if(score>=90) return "Lider"; if(score>=75) return "Örnek"; if(score>=55) return "Üreten"; if(score>=25) return "Aktif"; return "Başlangıç"; }

const storage = multer.diskStorage({
  destination: (req,file,cb)=>{
    let dir = "uploads/temp";
    if(file.fieldname==="logo") dir="uploads/logos";
    if(file.fieldname==="banner") dir="uploads/banners";
    if(file.fieldname==="poster") dir="uploads/posters";
    if(file.fieldname==="archive_photo") dir="uploads/archive";
    cb(null, path.join(__dirname, dir));
  },
  filename: (req,file,cb)=>{
    const ext = path.extname(file.originalname||"").toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`);
  }
});
const upload = multer({ storage, limits:{ fileSize: 8*1024*1024 }, fileFilter:(req,file,cb)=>{
  if(!file.mimetype.startsWith("image/")) return cb(new Error("Sadece görsel yüklenebilir"));
  cb(null,true);
}});

async function initMemory(){
  const hp = await hash("123456");
  memory.libraries = [
    {id:1,name:"Adıyaman Yeşilyurt Halk Kütüphanesi",slug:"yesilyurt",email:"yesilyurt@ktb.gov.tr",phone:"0416 000 00 00",address:"Yeşilyurt Mah. 2131 Sok. No:5 Merkez / ADIYAMAN",about:"Çocuk, genç ve yetişkin kullanıcılar için etkinlik, okuma, çalışma ve zeka oyunları hizmetleri sunan halk kütüphanesi.",working_hours:"08:00 - 19:00",score:92,rank_name:"Lider",status:"approved",logo_url:"",banner_url:"",logo_pos_x:50,logo_pos_y:50,logo_zoom:1.15,banner_pos_x:50,banner_pos_y:50},
    {id:2,name:"Serik Halk Kütüphanesi",slug:"serik",email:"serik@ktb.gov.tr",phone:"0242 000 00 00",address:"Serik / ANTALYA",about:"Etkinlik ve zeka oyunları odaklı demo kütüphane.",working_hours:"09:00 - 18:00",score:76,rank_name:"Örnek",status:"approved",logo_url:"",banner_url:"",logo_pos_x:50,logo_pos_y:50,logo_zoom:1.15,banner_pos_x:50,banner_pos_y:50}
  ];
  memory.users = [
    {id:1,email:"admin@ktb.gov.tr",password_hash:hp,role:"SUPER_ADMIN",library_id:null,active:true},
    {id:2,email:"yesilyurt@ktb.gov.tr",password_hash:hp,role:"LIBRARY_ADMIN",library_id:1,active:true},
    {id:3,email:"serik@ktb.gov.tr",password_hash:hp,role:"LIBRARY_ADMIN",library_id:2,active:true}
  ];
  memory.announcements=[{id:1,library_id:null,type:"global",title:"Platform yayında",body:"Dijital Kütüphane Platformu V4 yayında.",active:true},{id:2,library_id:1,type:"library",title:"Etkinlik başvuruları açıldı",body:"Çocuk etkinlikleri için başvurular başlamıştır.",active:true}];
  let id=1; for(const lib of memory.libraries){ for(let i=1;i<=18;i++){ memory.events.push({id:id++,library_id:lib.id,title:i%2?"Masal ve Okuma Saati":"Zeka Oyunları Atölyesi",description:"Katılım ücretsizdir. Kontenjan sınırlıdır.",category:i%2?"Okuma":"Zeka Oyunu",event_date:fdate(i),event_time:"15:00",place:lib.name,min_age:6,max_age:14,capacity:25,poster_url:"",is_archived:false,created_at:new Date().toISOString()});}}
  ["Satranç","Mangala","Hedef 5","Cezalı Tower","Amiral Battı","Ben Neyim?"].forEach((n,i)=>memory.games.push({id:i+1,library_id:i<4?1:2,name:n,category:"Zeka Oyunu",description:n+" açıklaması",how_to_play:"Kurallara göre oynanır.",age_range:"7+",players:"2-6",pieces:"Tam",shelf_code:"ZO-"+String(i+1).padStart(3,"0"),qr_code:"",available:true}));
}

async function initDb(){
  if(!usingPostgres){ await initMemory(); console.log("Memory demo modu aktif"); return; }
  await db(`
    CREATE TABLE IF NOT EXISTS libraries (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      about TEXT DEFAULT '',
      working_hours TEXT DEFAULT '',
      score INTEGER DEFAULT 0,
      rank_name TEXT DEFAULT 'Başlangıç',
      status TEXT DEFAULT 'pending',
      logo_url TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      logo_pos_x INTEGER DEFAULT 50,
      logo_pos_y INTEGER DEFAULT 50,
      logo_zoom NUMERIC DEFAULT 1.15,
      banner_pos_x INTEGER DEFAULT 50,
      banner_pos_y INTEGER DEFAULT 50,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      library_id BIGINT REFERENCES libraries(id) ON DELETE CASCADE,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      event_date DATE NOT NULL,
      event_time TEXT DEFAULT '',
      place TEXT DEFAULT '',
      min_age INTEGER DEFAULT 0,
      max_age INTEGER DEFAULT 99,
      capacity INTEGER DEFAULT 0,
      poster_url TEXT DEFAULT '',
      is_archived BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS applications (
      id BIGSERIAL PRIMARY KEY,
      library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      age INTEGER NOT NULL,
      status TEXT DEFAULT 'normal',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS games (
      id BIGSERIAL PRIMARY KEY,
      library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      description TEXT DEFAULT '',
      how_to_play TEXT DEFAULT '',
      age_range TEXT DEFAULT '',
      players TEXT DEFAULT '',
      pieces TEXT DEFAULT '',
      shelf_code TEXT DEFAULT '',
      qr_code TEXT DEFAULT '',
      available BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS archive_photos (
      id BIGSERIAL PRIMARY KEY,
      library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
      photo_url TEXT NOT NULL,
      caption TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id BIGSERIAL PRIMARY KEY,
      library_id BIGINT REFERENCES libraries(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'library',
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS surveys (
      id BIGSERIAL PRIMARY KEY,
      library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      q1 INTEGER, q2 INTEGER, q3 INTEGER, q4 INTEGER, q5 INTEGER,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_libraries_status_slug ON libraries(status, slug);
    CREATE INDEX IF NOT EXISTS idx_events_library_date ON events(library_id, event_date DESC);
    CREATE INDEX IF NOT EXISTS idx_applications_event ON applications(event_id);
    CREATE INDEX IF NOT EXISTS idx_games_library ON games(library_id);
    CREATE INDEX IF NOT EXISTS idx_surveys_library ON surveys(library_id);
    CREATE INDEX IF NOT EXISTS idx_archive_library_event ON archive_photos(library_id,event_id);
  `);

  // V4.1 Migration Fix:
  // Eski Render PostgreSQL veritabanında tablolar varsa ama yeni kolonlar yoksa,
  // sistemi bozmadan eksik kolonları ekler.
  await db(`
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS about TEXT DEFAULT '';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS working_hours TEXT DEFAULT '';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS rank_name TEXT DEFAULT 'Başlangıç';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT '';
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS logo_pos_x INTEGER DEFAULT 50;
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS logo_pos_y INTEGER DEFAULT 50;
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS logo_zoom NUMERIC DEFAULT 1.15;
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS banner_pos_x INTEGER DEFAULT 50;
    ALTER TABLE libraries ADD COLUMN IF NOT EXISTS banner_pos_y INTEGER DEFAULT 50;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

    ALTER TABLE events ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS event_time TEXT DEFAULT '';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS place TEXT DEFAULT '';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS min_age INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS max_age INTEGER DEFAULT 99;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS capacity INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_url TEXT DEFAULT '';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

    ALTER TABLE applications ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'normal';

    ALTER TABLE games ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS how_to_play TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS age_range TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS players TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS pieces TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS shelf_code TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS qr_code TEXT DEFAULT '';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS available BOOLEAN DEFAULT true;

    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'library';
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS body TEXT DEFAULT '';
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

    ALTER TABLE surveys ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';
  `);

  const hp = await hash("123456");
  const admin = await one("SELECT id FROM users WHERE email='admin@ktb.gov.tr'");
  if(!admin) await db("INSERT INTO users(email,password_hash,role,active) VALUES('admin@ktb.gov.tr',$1,'SUPER_ADMIN',true)", [hp]);

  const yes = await one("SELECT id FROM libraries WHERE slug='yesilyurt'");
  if(!yes){
    const lib = await one(`INSERT INTO libraries(name,slug,email,phone,address,about,working_hours,score,rank_name,status)
    VALUES($1,'yesilyurt','yesilyurt@ktb.gov.tr','0416 000 00 00','Yeşilyurt Mah. 2131 Sok. No:5 Merkez / ADIYAMAN',$2,'08:00 - 19:00',92,'Lider','approved') RETURNING id`, ["Adıyaman Yeşilyurt Halk Kütüphanesi","Çocuk, genç ve yetişkin kullanıcılar için etkinlik, okuma, çalışma ve zeka oyunları hizmetleri sunan halk kütüphanesi."]);
    await db("INSERT INTO users(email,password_hash,role,library_id,active) VALUES('yesilyurt@ktb.gov.tr',$1,'LIBRARY_ADMIN',$2,true) ON CONFLICT (email) DO NOTHING",[hp,lib.id]);
  }
  const ser = await one("SELECT id FROM libraries WHERE slug='serik'");
  if(!ser){
    const lib = await one(`INSERT INTO libraries(name,slug,email,phone,address,about,working_hours,score,rank_name,status)
    VALUES($1,'serik','serik@ktb.gov.tr','0242 000 00 00','Serik / ANTALYA',$2,'09:00 - 18:00',76,'Örnek','approved') RETURNING id`, ["Serik Halk Kütüphanesi","Etkinlik ve zeka oyunları odaklı demo kütüphane."]);
    await db("INSERT INTO users(email,password_hash,role,library_id,active) VALUES('serik@ktb.gov.tr',$1,'LIBRARY_ADMIN',$2,true) ON CONFLICT (email) DO NOTHING",[hp,lib.id]);
  }
  const evc = await one("SELECT COUNT(*)::int c FROM events");
  if(evc.c===0){
    const libs = await db("SELECT id,name FROM libraries WHERE status='approved'");
    for(const lib of libs){ for(let i=1;i<=18;i++){ await db(`INSERT INTO events(library_id,title,description,category,event_date,event_time,place,min_age,max_age,capacity) VALUES($1,$2,$3,$4,$5,'15:00',$6,6,14,25)`, [lib.id, i%2?"Masal ve Okuma Saati":"Zeka Oyunları Atölyesi","Katılım ücretsizdir. Kontenjan sınırlıdır.",i%2?"Okuma":"Zeka Oyunu",fdate(i),lib.name]);}}
  }
  const gc = await one("SELECT COUNT(*)::int c FROM games");
  if(gc.c===0){
    const y = await one("SELECT id FROM libraries WHERE slug='yesilyurt'");
    for(const n of ["Satranç","Mangala","Hedef 5","Cezalı Tower","Amiral Battı","Ben Neyim?"]){
      await db("INSERT INTO games(library_id,name,category,description,how_to_play,age_range,players,pieces,shelf_code,available) VALUES($1,$2,'Zeka Oyunu',$3,'Kurallara göre oynanır.','7+','2-6','Tam',$4,true)", [y.id,n,n+" açıklaması","ZO-"+Math.floor(Math.random()*999)]);
    }
  }
  const an = await one("SELECT COUNT(*)::int c FROM announcements");
  if(an.c===0) await db("INSERT INTO announcements(type,title,body,active) VALUES('global','Platform yayında','Dijital Kütüphane Platformu V4 yayında.',true)");
  console.log("PostgreSQL hazır");
}

/* Data helpers */
async function libs(where="approved"){
  if(usingPostgres) return db("SELECT * FROM libraries WHERE ($1='all' OR status=$1) ORDER BY score DESC, name ASC", [where]);
  return memory.libraries.filter(l=>where==="all"||l.status===where);
}
async function libBySlug(s){ if(usingPostgres) return one("SELECT * FROM libraries WHERE slug=$1 AND status='approved'",[s]); return memory.libraries.find(l=>l.slug===s&&l.status==="approved");}
async function libById(id){ if(usingPostgres) return one("SELECT * FROM libraries WHERE id=$1",[id]); return memory.libraries.find(l=>Number(l.id)===Number(id));}
async function userByEmail(email){ if(usingPostgres) return one("SELECT * FROM users WHERE email=$1",[email]); return memory.users.find(u=>u.email===email);}
async function eventsOf(library_id, opts={}){
  const {archived=false, limit=100, q="", category=""} = opts;
  if(usingPostgres) return db(`SELECT e.*, COALESCE(a.c,0)::int application_count FROM events e LEFT JOIN (SELECT event_id,COUNT(*) c FROM applications GROUP BY event_id) a ON a.event_id=e.id WHERE e.library_id=$1 AND e.is_archived=$2 AND ($3='' OR e.title ILIKE '%'||$3||'%') AND ($4='' OR e.category=$4) ORDER BY e.event_date ASC LIMIT $5`, [library_id,archived,q,category,limit]);
  return memory.events.filter(e=>Number(e.library_id)===Number(library_id)&&e.is_archived===archived&&(!q||e.title.toLowerCase().includes(q.toLowerCase()))&&(!category||e.category===category)).slice(0,limit).map(e=>({...e,application_count:memory.applications.filter(a=>a.event_id===e.id).length}));
}
async function gamesOf(library_id){ if(usingPostgres) return db("SELECT * FROM games WHERE library_id=$1 ORDER BY name",[library_id]); return memory.games.filter(g=>Number(g.library_id)===Number(library_id));}
async function appsOf(library_id=null){
  if(usingPostgres) return db(`SELECT a.*, e.title event_title, l.name library_name FROM applications a JOIN events e ON e.id=a.event_id JOIN libraries l ON l.id=a.library_id WHERE ($1::bigint IS NULL OR a.library_id=$1) ORDER BY a.created_at DESC LIMIT 500`,[library_id]);
  return memory.applications.filter(a=>!library_id||Number(a.library_id)===Number(library_id));
}
async function anns(library_id=null){ if(usingPostgres) return db("SELECT * FROM announcements WHERE active=true AND (library_id=$1 OR library_id IS NULL) ORDER BY created_at DESC LIMIT 5",[library_id]); return memory.announcements.filter(a=>a.active&&(a.library_id===library_id||a.library_id===null));}
async function photosOf(library_id, event_id=null){ if(usingPostgres) return db("SELECT p.*, e.title event_title FROM archive_photos p LEFT JOIN events e ON e.id=p.event_id WHERE p.library_id=$1 AND ($2::bigint IS NULL OR p.event_id=$2) ORDER BY p.created_at DESC",[library_id,event_id]); return memory.archive_photos.filter(p=>Number(p.library_id)===Number(library_id)&&(!event_id||Number(p.event_id)===Number(event_id)));}
async function surveysOf(library_id=null){ if(usingPostgres) return db("SELECT s.*, l.name library_name FROM surveys s JOIN libraries l ON l.id=s.library_id WHERE ($1::bigint IS NULL OR s.library_id=$1) ORDER BY s.created_at DESC LIMIT 500",[library_id]); return memory.surveys.filter(s=>!library_id||Number(s.library_id)===Number(library_id));}

function requireLogin(req,res,next){ if(!req.session.user) return res.redirect("/library-login"); next(); }
function requireAdmin(req,res,next){ if(!req.session.user || req.session.user.role!=="SUPER_ADMIN") return res.redirect("/admin-login"); next(); }
function requireLibrary(req,res,next){ if(!req.session.user || req.session.user.role!=="LIBRARY_ADMIN") return res.redirect("/library-login"); next(); }

app.use((req,res,next)=>{ res.locals.user=req.session.user||null; res.locals.path=req.path; res.locals.usingPostgres=usingPostgres; next(); });

/* Auth */
app.get("/library-login",(req,res)=>res.render("login",{type:"library",error:""}));
app.get("/admin-login",(req,res)=>res.render("login",{type:"admin",error:""}));
app.post("/login", async (req,res)=>{
  const {email,password,type}=req.body; const u=await userByEmail(esc(email));
  if(!u || !u.active || !(await cmp(password,u.password_hash))) return res.status(401).render("login",{type,error:"E-posta veya şifre hatalı ya da hesabınız onaylanmamış."});
  if(type==="admin" && u.role!=="SUPER_ADMIN") return res.status(403).render("login",{type,error:"Bu sayfa sadece süper admin içindir."});
  if(type==="library" && u.role!=="LIBRARY_ADMIN") return res.status(403).render("login",{type,error:"Bu sayfa sadece kütüphane yöneticisi içindir."});
  req.session.user={id:u.id,email:u.email,role:u.role,library_id:u.library_id};
  req.session.save(()=>res.redirect(u.role==="SUPER_ADMIN"?"/admin":"/panel"));
});
app.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/")));

app.get("/library-register",(req,res)=>res.render("register",{error:"",success:""}));
app.post("/library-register", async (req,res)=>{
  const name=esc(req.body.name), email=esc(req.body.email).toLowerCase(), pass=req.body.password||"123456";
  let s=slug(req.body.slug||name); if(!email.endsWith("@ktb.gov.tr")) return res.render("register",{error:"Sadece @ktb.gov.tr e-posta kabul edilir.",success:""});
  if(!s) return res.render("register",{error:"Slug oluşturulamadı.",success:""});
  const hp=await hash(pass);
  if(usingPostgres){
    const exist=await one("SELECT id FROM libraries WHERE slug=$1 OR email=$2",[s,email]);
    if(exist) return res.render("register",{error:"Bu slug veya e-posta zaten kayıtlı.",success:""});
    const lib=await one(`INSERT INTO libraries(name,slug,email,phone,address,about,status) VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,[name,s,email,esc(req.body.phone),esc(req.body.address),esc(req.body.about)]);
    await db("INSERT INTO users(email,password_hash,role,library_id,active) VALUES($1,$2,'LIBRARY_ADMIN',$3,false)",[email,hp,lib.id]);
  } else {
    const id=memory.libraries.length+1; memory.libraries.push({id,name,slug:s,email,phone:esc(req.body.phone),address:esc(req.body.address),about:esc(req.body.about),working_hours:"",score:0,rank_name:"Başlangıç",status:"pending",logo_url:"",banner_url:"",logo_pos_x:50,logo_pos_y:50,logo_zoom:1.15,banner_pos_x:50,banner_pos_y:50});
    memory.users.push({id:memory.users.length+1,email,password_hash:hp,role:"LIBRARY_ADMIN",library_id:id,active:false});
  }
  res.render("register",{error:"",success:"Başvurunuz alınmıştır. Süper admin onayı bekleniyor."});
});

/* Home */
app.get("/", async (req,res)=>{
  const all=await libs("approved");
  const stats={libraries:all.length, events: usingPostgres?(await one("SELECT COUNT(*)::int c FROM events")).c:memory.events.length, games: usingPostgres?(await one("SELECT COUNT(*)::int c FROM games")).c:memory.games.length};
  res.render("home",{libraries:all,stats,q:req.query.q||""});
});

/* Admin */
app.get("/admin", requireAdmin, async (req,res)=>{
  const all=await libs("all"); const apps=await appsOf(null);
  const stats={libraries:all.length,pending:all.filter(l=>l.status==="pending").length,applications:apps.length,events:usingPostgres?(await one("SELECT COUNT(*)::int c FROM events")).c:memory.events.length,games:usingPostgres?(await one("SELECT COUNT(*)::int c FROM games")).c:memory.games.length};
  res.render("admin-dashboard",{stats,libraries:all.slice(0,8)});
});
app.get("/admin/libraries", requireAdmin, async (req,res)=>res.render("admin-libraries",{libraries:await libs("all")}));
app.post("/admin/libraries/:id/approve", requireAdmin, async (req,res)=>{
  const id=req.params.id; if(usingPostgres){ await db("UPDATE libraries SET status='approved' WHERE id=$1",[id]); await db("UPDATE users SET active=true WHERE library_id=$1",[id]); } else { const l=memory.libraries.find(x=>x.id==id); if(l)l.status="approved"; memory.users.filter(u=>u.library_id==id).forEach(u=>u.active=true);}
  res.redirect("/admin/libraries");
});
app.post("/admin/libraries/:id/reject", requireAdmin, async (req,res)=>{
  const id=req.params.id; if(usingPostgres){ await db("UPDATE libraries SET status='rejected' WHERE id=$1",[id]); await db("UPDATE users SET active=false WHERE library_id=$1",[id]); } else { const l=memory.libraries.find(x=>x.id==id); if(l)l.status="rejected"; memory.users.filter(u=>u.library_id==id).forEach(u=>u.active=false);}
  res.redirect("/admin/libraries");
});
app.get("/admin/applications", requireAdmin, async (req,res)=>res.render("admin-applications",{applications:await appsOf(null)}));
app.get("/admin/announcements", requireAdmin, async (req,res)=>res.render("admin-announcements",{announcements: usingPostgres? await db("SELECT * FROM announcements ORDER BY created_at DESC"):memory.announcements}));
app.post("/admin/announcements", requireAdmin, async (req,res)=>{
  if(usingPostgres) await db("INSERT INTO announcements(type,title,body,active) VALUES('global',$1,$2,true)",[esc(req.body.title),esc(req.body.body)]);
  else memory.announcements.push({id:memory.announcements.length+1,library_id:null,type:"global",title:esc(req.body.title),body:esc(req.body.body),active:true});
  res.redirect("/admin/announcements");
});
app.get("/admin/ranking", requireAdmin, async (req,res)=>res.render("admin-ranking",{libraries:await libs("approved")}));
app.get("/admin/surveys", requireAdmin, async (req,res)=>res.render("admin-surveys",{surveys:await surveysOf(null)}));

/* Library panel */
app.get("/panel", requireLibrary, async (req,res)=>{
  const lib=await libById(req.session.user.library_id), ev=await eventsOf(lib.id,{limit:6}), gm=await gamesOf(lib.id), ap=await appsOf(lib.id), sv=await surveysOf(lib.id), ph=await photosOf(lib.id);
  res.render("panel-dashboard",{lib,stats:{events:ev.length,games:gm.length,applications:ap.length,surveys:sv.length,photos:ph.length}});
});
app.get("/panel/settings", requireLibrary, async (req,res)=>res.render("panel-settings",{lib:await libById(req.session.user.library_id)}));
app.post("/panel/settings", requireLibrary, async (req,res)=>{
  const id=req.session.user.library_id, b=req.body;
  if(usingPostgres) await db(`UPDATE libraries SET about=$1,working_hours=$2,phone=$3,address=$4,logo_pos_x=$5,logo_pos_y=$6,logo_zoom=$7,banner_pos_x=$8,banner_pos_y=$9 WHERE id=$10`,[esc(b.about),esc(b.working_hours),esc(b.phone),esc(b.address),Number(b.logo_pos_x||50),Number(b.logo_pos_y||50),Number(b.logo_zoom||1.15),Number(b.banner_pos_x||50),Number(b.banner_pos_y||50),id]);
  else Object.assign(memory.libraries.find(l=>l.id==id),{about:esc(b.about),working_hours:esc(b.working_hours),phone:esc(b.phone),address:esc(b.address),logo_pos_x:Number(b.logo_pos_x||50),logo_pos_y:Number(b.logo_pos_y||50),logo_zoom:Number(b.logo_zoom||1.15),banner_pos_x:Number(b.banner_pos_x||50),banner_pos_y:Number(b.banner_pos_y||50)});
  res.redirect("/panel/settings");
});
app.get("/panel/media", requireLibrary, async (req,res)=>res.render("panel-media",{lib:await libById(req.session.user.library_id)}));
app.post("/panel/media/logo", requireLibrary, upload.single("logo"), async (req,res)=>{
  if(!req.file) return res.redirect("/panel/media"); const url="/uploads/logos/"+req.file.filename, id=req.session.user.library_id;
  if(usingPostgres) await db("UPDATE libraries SET logo_url=$1 WHERE id=$2",[url,id]); else memory.libraries.find(l=>l.id==id).logo_url=url;
  res.redirect("/panel/media");
});
app.post("/panel/media/banner", requireLibrary, upload.single("banner"), async (req,res)=>{
  if(!req.file) return res.redirect("/panel/media"); const url="/uploads/banners/"+req.file.filename, id=req.session.user.library_id;
  if(usingPostgres) await db("UPDATE libraries SET banner_url=$1 WHERE id=$2",[url,id]); else memory.libraries.find(l=>l.id==id).banner_url=url;
  res.redirect("/panel/media");
});
app.get("/panel/events", requireLibrary, async (req,res)=>res.render("panel-events",{lib:await libById(req.session.user.library_id),events:await eventsOf(req.session.user.library_id,{limit:500})}));
app.post("/panel/events", requireLibrary, upload.single("poster"), async (req,res)=>{
  const b=req.body, poster=req.file?"/uploads/posters/"+req.file.filename:"";
  if(usingPostgres) await db(`INSERT INTO events(library_id,title,description,category,event_date,event_time,place,min_age,max_age,capacity,poster_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[req.session.user.library_id,esc(b.title),esc(b.description),esc(b.category),b.event_date,esc(b.event_time),esc(b.place),Number(b.min_age||0),Number(b.max_age||99),Number(b.capacity||0),poster]);
  else memory.events.push({id:memory.events.length+1,library_id:req.session.user.library_id,title:esc(b.title),description:esc(b.description),category:esc(b.category),event_date:b.event_date,event_time:esc(b.event_time),place:esc(b.place),min_age:Number(b.min_age||0),max_age:Number(b.max_age||99),capacity:Number(b.capacity||0),poster_url:poster,is_archived:false,created_at:new Date().toISOString()});
  res.redirect("/panel/events");
});
app.post("/panel/events/:id/archive", requireLibrary, async (req,res)=>{ if(usingPostgres) await db("UPDATE events SET is_archived=true WHERE id=$1 AND library_id=$2",[req.params.id,req.session.user.library_id]); else {const e=memory.events.find(x=>x.id==req.params.id&&x.library_id==req.session.user.library_id); if(e)e.is_archived=true;} res.redirect("/panel/events");});
app.post("/panel/events/:id/delete", requireLibrary, async (req,res)=>{ if(usingPostgres) await db("DELETE FROM events WHERE id=$1 AND library_id=$2",[req.params.id,req.session.user.library_id]); else memory.events=memory.events.filter(e=>!(e.id==req.params.id&&e.library_id==req.session.user.library_id)); res.redirect("/panel/events");});
app.get("/panel/applications", requireLibrary, async (req,res)=>res.render("panel-applications",{applications:await appsOf(req.session.user.library_id)}));
app.post("/panel/applications/:id/cancel", requireLibrary, async (req,res)=>{ if(usingPostgres) await db("UPDATE applications SET status='cancelled' WHERE id=$1 AND library_id=$2",[req.params.id,req.session.user.library_id]); else {const a=memory.applications.find(x=>x.id==req.params.id&&x.library_id==req.session.user.library_id); if(a)a.status="cancelled";} res.redirect("/panel/applications");});
app.get("/panel/games", requireLibrary, async (req,res)=>res.render("panel-games",{games:await gamesOf(req.session.user.library_id)}));
app.post("/panel/games", requireLibrary, async (req,res)=>{
  const b=req.body; if(usingPostgres) await db(`INSERT INTO games(library_id,name,category,description,how_to_play,age_range,players,pieces,shelf_code,available) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[req.session.user.library_id,esc(b.name),esc(b.category),esc(b.description),esc(b.how_to_play),esc(b.age_range),esc(b.players),esc(b.pieces),esc(b.shelf_code),b.available==="on"]);
  else memory.games.push({id:memory.games.length+1,library_id:req.session.user.library_id,name:esc(b.name),category:esc(b.category),description:esc(b.description),how_to_play:esc(b.how_to_play),age_range:esc(b.age_range),players:esc(b.players),pieces:esc(b.pieces),shelf_code:esc(b.shelf_code),available:b.available==="on"});
  res.redirect("/panel/games");
});
app.post("/panel/games/:id/delete", requireLibrary, async (req,res)=>{ if(usingPostgres) await db("DELETE FROM games WHERE id=$1 AND library_id=$2",[req.params.id,req.session.user.library_id]); else memory.games=memory.games.filter(g=>!(g.id==req.params.id&&g.library_id==req.session.user.library_id)); res.redirect("/panel/games");});
app.get("/panel/archive", requireLibrary, async (req,res)=>res.render("panel-archive",{events:await eventsOf(req.session.user.library_id,{archived:true,limit:500}),photos:await photosOf(req.session.user.library_id)}));
app.post("/panel/archive/:eventId/photo", requireLibrary, upload.single("archive_photo"), async (req,res)=>{ if(req.file){ const url="/uploads/archive/"+req.file.filename; if(usingPostgres) await db("INSERT INTO archive_photos(library_id,event_id,photo_url,caption) VALUES($1,$2,$3,$4)",[req.session.user.library_id,req.params.eventId,url,esc(req.body.caption)]); else memory.archive_photos.push({id:memory.archive_photos.length+1,library_id:req.session.user.library_id,event_id:Number(req.params.eventId),photo_url:url,caption:esc(req.body.caption)});} res.redirect("/panel/archive");});
app.post("/panel/archive/photo/:id/delete", requireLibrary, async (req,res)=>{ if(usingPostgres) await db("DELETE FROM archive_photos WHERE id=$1 AND library_id=$2",[req.params.id,req.session.user.library_id]); else memory.archive_photos=memory.archive_photos.filter(p=>!(p.id==req.params.id&&p.library_id==req.session.user.library_id)); res.redirect("/panel/archive");});
app.get("/panel/surveys", requireLibrary, async (req,res)=>res.render("panel-surveys",{surveys:await surveysOf(req.session.user.library_id)}));

/* Public pages */
app.get("/:slug", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); res.render("library",{lib,announcements:await anns(lib.id),events:await eventsOf(lib.id,{limit:4}),games:await gamesOf(lib.id)});});
app.get("/:slug/events", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); res.render("events",{lib,events:await eventsOf(lib.id,{q:req.query.q||"",category:req.query.category||"",limit:100}),q:req.query.q||"",category:req.query.category||"",error:""});});
app.post("/:slug/events/:id/apply", async (req,res,next)=>{
  const lib=await libBySlug(req.params.slug); if(!lib)return next(); const eventId=Number(req.params.id), phone=esc(req.body.phone), age=Number(req.body.age||0);
  if(!/^05\d{9}$/.test(phone)) return res.status(400).send("Telefon 05 ile başlamalı ve 11 hane olmalı.");
  let ev; if(usingPostgres) ev=await one("SELECT * FROM events WHERE id=$1 AND library_id=$2 AND is_archived=false",[eventId,lib.id]); else ev=memory.events.find(e=>e.id===eventId&&e.library_id===lib.id&&!e.is_archived);
  if(!ev)return next(); if(age<ev.min_age||age>ev.max_age) return res.status(400).send("Yaş aralığı uygun değil.");
  let count=0; if(usingPostgres) count=(await one("SELECT COUNT(*)::int c FROM applications WHERE event_id=$1 AND status!='cancelled'",[eventId])).c; else count=memory.applications.filter(a=>a.event_id===eventId&&a.status!=="cancelled").length;
  const st=count>=ev.capacity?"reserve":"normal";
  if(usingPostgres) await db("INSERT INTO applications(library_id,event_id,first_name,last_name,phone,age,status) VALUES($1,$2,$3,$4,$5,$6,$7)",[lib.id,eventId,esc(req.body.first_name),esc(req.body.last_name),phone,age,st]);
  else memory.applications.push({id:memory.applications.length+1,library_id:lib.id,event_id:eventId,first_name:esc(req.body.first_name),last_name:esc(req.body.last_name),phone,age,status:st});
  res.redirect(`/${lib.slug}/events?success=1`);
});
app.get("/:slug/archive", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); res.render("archive",{lib,events:await eventsOf(lib.id,{archived:true,limit:100}),photos:await photosOf(lib.id)});});
app.get("/:slug/games", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); res.render("games",{lib,games:await gamesOf(lib.id)});});
app.get("/:slug/survey", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); res.render("survey",{lib,success:""});});
app.post("/:slug/survey", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); const vals=[1,2,3,4,5].map(i=>Number(req.body["q"+i]||5)); if(usingPostgres) await db("INSERT INTO surveys(library_id,q1,q2,q3,q4,q5,note) VALUES($1,$2,$3,$4,$5,$6,$7)",[lib.id,...vals,esc(req.body.note)]); else memory.surveys.push({id:memory.surveys.length+1,library_id:lib.id,q1:vals[0],q2:vals[1],q3:vals[2],q4:vals[3],q5:vals[4],note:esc(req.body.note)}); res.render("survey",{lib,success:"Anketiniz alınmıştır."});});
app.get("/:slug/contact", async (req,res,next)=>{ const lib=await libBySlug(req.params.slug); if(!lib)return next(); res.render("contact",{lib});});

app.use((req,res)=>res.status(404).render("404"));

initDb().then(()=>app.listen(PORT,()=>console.log(`Server çalışıyor: ${PORT}`))).catch(e=>{ console.error("Başlatma hatası:",e); process.exit(1);});
