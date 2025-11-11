from fastapi import FastAPI, APIRouter, HTTPException, Header
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict, EmailStr
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone
import secrets

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Admin password (hardcoded for simplicity)
ADMIN_PASSWORD = "admin123"

# In-memory admin sessions (simple token-based auth)
admin_sessions = set()

# Define Models
class ParticipantCreate(BaseModel):
    name: str
    email: EmailStr
    whatsapp: str

class Participant(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    email: str
    whatsapp: str
    type: Literal["bancas", "vivo"]  # 20 Bancas or Ao Vivo
    registration_date: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class AdminLogin(BaseModel):
    password: str

class AdminLoginResponse(BaseModel):
    token: str
    message: str

class DrawBancasResponse(BaseModel):
    winners: List[Participant]
    message: str

class DrawVivoResponse(BaseModel):
    winner: Participant
    message: str

class RegisterResult(BaseModel):
    email: str
    initial_value: float
    final_value: float

class HistoryEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: Literal["20 Bancas", "Ao Vivo"]
    name: str
    email: str
    whatsapp: str
    date: str  # YYYY-MM-DD
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    result: Optional[str] = None  # "Lucro: R$100,00" or "Prejuízo: R$50,00"
    initial_value: Optional[float] = None
    final_value: Optional[float] = None

class HistoryPublic(BaseModel):
    id: str
    type: str
    name: str
    email: str  # Will be masked
    date: str
    timestamp: datetime
    result: Optional[str] = None

# Helper function to mask email
def mask_email(email: str) -> str:
    if not email or '@' not in email:
        return 'N/A'
    user, domain = email.split('@')
    masked_user = user[:2] + '***' + user[-1:] if len(user) > 3 else '***'
    domain_parts = domain.split('.')
    masked_domain = domain_parts[0][:2] + '***.' + '.'.join(domain_parts[1:]) if len(domain_parts[0]) > 3 else '***.' + '.'.join(domain_parts[1:])
    return f"{masked_user}@{masked_domain}"

# Middleware to check admin auth
async def verify_admin(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail="Não autorizado")
    token = authorization.replace('Bearer ', '')
    if token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Token inválido ou expirado")
    return True

# Routes
@api_router.get("/")
async def root():
    return {"message": "Sistema de Sorteio - Telegram Draw PRO"}

# Participant Registration
@api_router.post("/participants/bancas", response_model=dict)
async def register_bancas(input: ParticipantCreate):
    # Check for duplicate email
    existing = await db.participants.find_one({"email": input.email.lower(), "type": "bancas"})
    if existing:
        raise HTTPException(status_code=400, detail="E-mail já cadastrado neste sorteio!")
    
    # Check for duplicate whatsapp
    existing_whats = await db.participants.find_one({"whatsapp": input.whatsapp, "type": "bancas"})
    if existing_whats:
        raise HTTPException(status_code=400, detail="WhatsApp já cadastrado neste sorteio!")
    
    participant = Participant(**input.model_dump(), type="bancas")
    doc = participant.model_dump()
    doc['registration_date'] = doc['registration_date'].isoformat()
    doc['email'] = doc['email'].lower()
    
    await db.participants.insert_one(doc)
    return {"success": True, "message": "Cadastro realizado com sucesso!"}

@api_router.post("/participants/vivo", response_model=dict)
async def register_vivo(input: ParticipantCreate):
    # Check for duplicate email
    existing = await db.participants.find_one({"email": input.email.lower(), "type": "vivo"})
    if existing:
        raise HTTPException(status_code=400, detail="E-mail já cadastrado neste sorteio!")
    
    # Check for duplicate whatsapp
    existing_whats = await db.participants.find_one({"whatsapp": input.whatsapp, "type": "vivo"})
    if existing_whats:
        raise HTTPException(status_code=400, detail="WhatsApp já cadastrado neste sorteio!")
    
    participant = Participant(**input.model_dump(), type="vivo")
    doc = participant.model_dump()
    doc['registration_date'] = doc['registration_date'].isoformat()
    doc['email'] = doc['email'].lower()
    
    await db.participants.insert_one(doc)
    return {"success": True, "message": "Cadastro realizado com sucesso!"}

# Get Participants (Admin only)
@api_router.get("/admin/participants/bancas", response_model=List[Participant])
async def get_bancas_participants(authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    participants = await db.participants.find({"type": "bancas"}, {"_id": 0}).to_list(10000)
    for p in participants:
        if isinstance(p['registration_date'], str):
            p['registration_date'] = datetime.fromisoformat(p['registration_date'])
    return participants

@api_router.get("/admin/participants/vivo", response_model=List[Participant])
async def get_vivo_participants(authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    participants = await db.participants.find({"type": "vivo"}, {"_id": 0}).to_list(10000)
    for p in participants:
        if isinstance(p['registration_date'], str):
            p['registration_date'] = datetime.fromisoformat(p['registration_date'])
    return participants

# Get participant counts (public)
@api_router.get("/participants/count")
async def get_participant_count():
    bancas_count = await db.participants.count_documents({"type": "bancas"})
    vivo_count = await db.participants.count_documents({"type": "vivo"})
    return {"bancas": bancas_count, "vivo": vivo_count}

# Admin Login
@api_router.post("/admin/login", response_model=AdminLoginResponse)
async def admin_login(input: AdminLogin):
    if input.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Senha incorreta!")
    
    token = secrets.token_urlsafe(32)
    admin_sessions.add(token)
    return {"token": token, "message": "Login realizado com sucesso!"}

# Draw 20 Bancas
@api_router.post("/admin/draw/bancas", response_model=DrawBancasResponse)
async def draw_bancas(authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    participants = await db.participants.find({"type": "bancas"}, {"_id": 0}).to_list(10000)
    
    if len(participants) < 20:
        raise HTTPException(status_code=400, detail="Mínimo 20 participantes para este sorteio!")
    
    # Shuffle and select 20 winners
    import random
    winners = random.sample(participants, 20)
    
    # Add to history
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    for winner in winners:
        history_entry = HistoryEntry(
            type="20 Bancas",
            name=winner['name'],
            email=winner['email'],
            whatsapp=winner['whatsapp'],
            date=today
        )
        doc = history_entry.model_dump()
        doc['timestamp'] = doc['timestamp'].isoformat()
        await db.history.insert_one(doc)
    
    # Convert to Participant objects
    winner_objs = []
    for w in winners:
        if isinstance(w['registration_date'], str):
            w['registration_date'] = datetime.fromisoformat(w['registration_date'])
        winner_objs.append(Participant(**w))
    
    return {"winners": winner_objs, "message": "Sorteio realizado com sucesso!"}

# Draw 1 Ao Vivo
@api_router.post("/admin/draw/vivo", response_model=DrawVivoResponse)
async def draw_vivo(authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    participants = await db.participants.find({"type": "vivo"}, {"_id": 0}).to_list(10000)
    
    if len(participants) == 0:
        raise HTTPException(status_code=400, detail="Nenhum participante disponível para o sorteio!")
    
    # Select random winner
    import random
    winner = random.choice(participants)
    
    # Add to history (without result initially)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    history_entry = HistoryEntry(
        type="Ao Vivo",
        name=winner['name'],
        email=winner['email'],
        whatsapp=winner['whatsapp'],
        date=today,
        result=None
    )
    doc = history_entry.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    await db.history.insert_one(doc)
    
    # Remove from participants
    await db.participants.delete_one({"email": winner['email'], "type": "vivo"})
    
    if isinstance(winner['registration_date'], str):
        winner['registration_date'] = datetime.fromisoformat(winner['registration_date'])
    
    return {"winner": Participant(**winner), "message": "Ganhador sorteado!"}

# Register Result (Ao Vivo)
@api_router.post("/admin/result")
async def register_result(input: RegisterResult, authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    diff = input.final_value - input.initial_value
    result = f"Lucro: R${abs(diff):.2f}".replace('.', ',') if diff >= 0 else f"Prejuízo: R${abs(diff):.2f}".replace('.', ',')
    
    # Update the latest history entry for this email without result
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    await db.history.update_one(
        {"email": input.email.lower(), "type": "Ao Vivo", "date": today, "result": None},
        {"$set": {
            "result": result,
            "initial_value": input.initial_value,
            "final_value": input.final_value
        }}
    )
    
    return {"success": True, "message": "Resultado registrado com sucesso!"}

# Get History (Public - emails masked)
@api_router.get("/history", response_model=List[HistoryPublic])
async def get_history_public():
    history = await db.history.find({}, {"_id": 0}).to_list(10000)
    
    # Filter out entries without results (except 20 Bancas)
    filtered = [h for h in history if h['result'] is not None or h['type'] == '20 Bancas']
    
    for entry in filtered:
        if isinstance(entry['timestamp'], str):
            entry['timestamp'] = datetime.fromisoformat(entry['timestamp'])
        entry['email'] = mask_email(entry['email'])
    
    # Sort by timestamp desc
    filtered.sort(key=lambda x: x['timestamp'], reverse=True)
    
    return filtered

# Get History (Admin - full emails)
@api_router.get("/admin/history", response_model=List[HistoryEntry])
async def get_history_admin(authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    history = await db.history.find({}, {"_id": 0}).to_list(10000)
    
    for entry in history:
        if isinstance(entry['timestamp'], str):
            entry['timestamp'] = datetime.fromisoformat(entry['timestamp'])
    
    # Sort by timestamp desc
    history.sort(key=lambda x: x['timestamp'], reverse=True)
    
    return history

# Delete Participant (Admin)
@api_router.delete("/admin/participant/{participant_id}")
async def delete_participant(participant_id: str, authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    result = await db.participants.delete_one({"id": participant_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Participante não encontrado")
    
    return {"success": True, "message": "Participante removido com sucesso!"}

# Delete History Entry (Admin)
@api_router.delete("/admin/history/{history_id}")
async def delete_history(history_id: str, authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    result = await db.history.delete_one({"id": history_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Entrada não encontrada")
    
    return {"success": True, "message": "Entrada removida do histórico!"}

# Clear All Participants (Admin)
@api_router.delete("/admin/clear-all")
async def clear_all_participants(authorization: Optional[str] = Header(None)):
    await verify_admin(authorization)
    
    await db.participants.delete_many({})
    
    return {"success": True, "message": "Todos os participantes foram removidos!"}

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()