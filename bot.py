import os
import asyncio
import threading
import http.server
import socketserver
from aiogram import Bot, Dispatcher, types
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.filters import Command

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_URL = "https://vidnoe-production.up.railway.app"

if not BOT_TOKEN:
    print("⚠️ BOT_TOKEN не найден! Бот не запустится.")
    BOT_TOKEN = "FAKE_TOKEN_FOR_HTML_ONLY"

bot = Bot(token=BOT_TOKEN) if BOT_TOKEN != "FAKE_TOKEN_FOR_HTML_ONLY" else None
dp = Dispatcher() if bot else None

if dp:
    @dp.message(Command("start"))
    async def start(message: types.Message):
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(
                text="🚀 Открыть Авито Видное",
                web_app=WebAppInfo(url=WEBAPP_URL)
            )]
        ])
        await message.answer(
            "🏠 *Авито Видное*\n\nДобро пожаловать! Нажмите кнопку ниже 👇",
            reply_markup=keyboard,
            parse_mode="Markdown"
        )

def run_webserver():
    PORT = int(os.getenv("PORT", 8080))
    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"✅ Веб-сервер запущен на порту {PORT}")
        httpd.serve_forever()

async def run_bot():
    if bot:
        print("🤖 Бот запущен!")
        await dp.start_polling(bot)
    else:
        print("⚠️ Бот не запущен: нет BOT_TOKEN")

if __name__ == "__main__":
    # Запускаем веб-сервер
    web_thread = threading.Thread(target=run_webserver, daemon=True)
    web_thread.start()
    
    # Запускаем бота
    asyncio.run(run_bot())
