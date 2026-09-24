"""Тести модуля dota.db — робота з SQLite на окремій тимчасовій БД."""

import os

import pandas as pd
import pytest

from dota import db


@pytest.fixture()
def db_path(tmp_path):
    path = os.path.join(tmp_path, "test_dota.db")
    db.init_db(path)
    return path


def test_init_db_creates_schema(db_path):
    assert os.path.exists(db_path)
    db.init_db(db_path)  # повторний виклик повинен бути ідемпотентним


def test_make_hash_is_deterministic_sha256():
    assert len(db.make_hash("secret")) == 64
    assert db.make_hash("secret") == db.make_hash("secret")
    assert db.make_hash("secret") != db.make_hash("Secret")


def test_add_and_login_user(db_path):
    assert db.add_user("pasha", "qwerty", db_path) is True
    assert db.login_user("pasha", "qwerty", db_path) is True
    assert db.login_user("pasha", "wrong", db_path) is False
    assert db.login_user("nobody", "qwerty", db_path) is False


def test_duplicate_username_rejected(db_path):
    db.add_user("pasha", "one", db_path)
    assert db.add_user("pasha", "two", db_path) is False


def test_save_and_get_history(db_path):
    db.add_user("pasha", "qwerty", db_path)
    db.save_prediction("pasha", ["A", "B", "C", "D", "E"], ["F", "G", "H", "I", "J"],
                       55.0, 45.0, "Radiant", db_path)
    history = db.get_prediction_history("pasha", db_path)
    assert isinstance(history, pd.DataFrame)
    assert len(history) == 1
    assert history.iloc[0]["Прогнозований переможець"] == "Radiant"
    assert history.iloc[0]["Шанс Radiant (%)"] == 55.0


def test_history_isolated_per_user(db_path):
    db.add_user("u1", "p", db_path)
    db.add_user("u2", "p", db_path)
    db.save_prediction("u1", ["A"] * 5, ["B"] * 5, 60.0, 40.0, "Radiant", db_path)
    assert db.get_prediction_history("u2", db_path).empty
    assert len(db.get_prediction_history("u1", db_path)) == 1


def test_clear_history(db_path):
    db.add_user("pasha", "qwerty", db_path)
    db.save_prediction("pasha", ["A"] * 5, ["B"] * 5, 50.0, 50.0, "Нічия", db_path)
    db.clear_prediction_history("pasha", db_path)
    assert db.get_prediction_history("pasha", db_path).empty