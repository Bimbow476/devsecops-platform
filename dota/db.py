"""Робота з SQLite-базою даних системи аналітики Dota 2.

Функції винесені з app.py, щоб їх можна було покрити автотестами (pytest),
а шлях до БД налаштовувати через змінну середовища DOTA_DB_PATH
(у контейнері / Kubernetes база зберігається на volume).
"""

import hashlib
import os
import sqlite3
from datetime import datetime

import pandas as pd

# Шлях до БД: DOTA_DB_PATH (контейнер/K8s) або файл поряд із застосунком (локальний запуск)
DB_PATH = os.environ.get("DOTA_DB_PATH", "dota_analytics.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
);

CREATE TABLE IF NOT EXISTS prediction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    timestamp TEXT,
    radiant_heroes TEXT,
    dire_heroes TEXT,
    radiant_chance REAL,
    dire_chance REAL,
    predicted_winner TEXT
);
"""


def make_hash(password: str) -> str:
    """SHA-256 хеш пароля (демо; у продакшні для паролів використовують bcrypt/argon2)."""
    return hashlib.sha256(str.encode(password)).hexdigest()


def _connect(db_path: str) -> sqlite3.Connection:
    return sqlite3.connect(db_path)


def init_db(db_path: str = DB_PATH) -> None:
    """Створює таблиці users та prediction_history, якщо їх ще немає."""
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = _connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def add_user(username: str, password: str, db_path: str = DB_PATH) -> bool:
    """Реєстрація користувача. Повертає False, якщо логін вже зайнятий."""
    conn = _connect(db_path)
    try:
        conn.execute(
            "INSERT INTO users (username, password) VALUES (?, ?)",
            (username, make_hash(password)),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def login_user(username: str, password: str, db_path: str = DB_PATH) -> bool:
    """Перевірка логіна та пароля."""
    conn = _connect(db_path)
    row = conn.execute(
        "SELECT 1 FROM users WHERE username = ? AND password = ?",
        (username, make_hash(password)),
    ).fetchone()
    conn.close()
    return row is not None


def save_prediction(
    username: str,
    radiant_list: list,
    dire_list: list,
    rad_chance: float,
    dir_chance: float,
    winner: str,
    db_path: str = DB_PATH,
) -> None:
    """Зберігає прогноз у персональну історію користувача."""
    conn = _connect(db_path)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        """
        INSERT INTO prediction_history
            (username, timestamp, radiant_heroes, dire_heroes,
             radiant_chance, dire_chance, predicted_winner)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (username, now, ", ".join(radiant_list), ", ".join(dire_list),
         rad_chance, dir_chance, winner),
    )
    conn.commit()
    conn.close()


def get_prediction_history(username: str, db_path: str = DB_PATH) -> pd.DataFrame:
    """Повертає історію прогнозів користувача (новіші зверху)."""
    conn = _connect(db_path)
    query = """
        SELECT timestamp AS 'Час прогнозу',
               radiant_heroes AS 'Склад Radiant',
               dire_heroes AS 'Склад Dire',
               radiant_chance AS 'Шанс Radiant (%)',
               dire_chance AS 'Шанс Dire (%)',
               predicted_winner AS 'Прогнозований переможець'
        FROM prediction_history
        WHERE username = ?
        ORDER BY id DESC
    """
    df = pd.read_sql_query(query, conn, params=(username,))
    conn.close()
    return df


def clear_prediction_history(username: str, db_path: str = DB_PATH) -> None:
    """Очищає персональну історію прогнозів користувача."""
    conn = _connect(db_path)
    conn.execute("DELETE FROM prediction_history WHERE username = ?", (username,))
    conn.commit()
    conn.close()