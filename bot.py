import os
import asyncio
from aiogram import Bot, Dispatcher, types
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.filters import Command

# Берём переменные из окружения Railway
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
WEBAPP_URL = "https://vidnoe-production.up.railway.app"

if not BOT_TOKEN:
    raise Exception("❌ BOT_TOKEN не найден в переменных окружения!")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

@dp.message(Command("start"))
async def start(message: types.Message):
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="🚀 Открыть Авито Видное",
            web_app=WebAppInfo(url=WEBAPP_URL)
        )]
    ])
    await message.answer(
        "🏠 *Авито Видное*\n\n"
        "Добро пожаловать! Здесь вы можете:\n"
        "✅ Размещать объявления\n"
        "✅ Покупать товары\n"
        "✅ Продвигать через Stars\n\n"
        "Нажмите кнопку ниже, чтобы открыть приложение 👇",
        reply_markup=keyboard,
        parse_mode="Markdown"
    )

@dp.message(Command("admin"))
async def admin(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        await message.answer("⛔ Доступ запрещён")
        return
    await message.answer(
        "👑 *Админ-панель*\n\n"
        f"📊 Статистика в приложении\n"
        f"🔗 Ссылка: {WEBAPP_URL}",
        parse_mode="Markdown"
    )

async def main():
    print("🤖 Бот запущен!")
    print(f"📱 WebApp URL: {WEBAPP_URL}")
    print(f"👑 Admin ID: {ADMIN_ID}")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
