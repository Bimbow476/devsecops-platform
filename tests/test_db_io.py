"""Тести експорту/імпорту історії прогнозів (dota.db)."""

import json
import os
from io import StringIO

import pandas as pd
import pytest

from dota import db


@pytest.fixture()
def db_path(tmp_path):
    path = os.path.join(tmp_path, "test_io.db")
    db.init_db(path)
    return path


@pytest.fixture()
def user_with_history(db_path):
    db.add_user("pasha", "qwerty", db_path)
    db.save_prediction(
        "pasha", ["A", "B", "C", "D", "E"], ["F", "G", "H", "I", "J"],
        55.0, 45.0, "Radiant", db_path,
    )
    db.save_prediction(
        "pasha", ["K", "L", "M", "N", "O"], ["P", "Q", "R", "S", "T"],
        40.0, 60.0, "Dire", db_path,
    )
    return db_path


def test_export_csv_parseable(user_with_history):
    csv_text = db.export_predictions_csv("pasha", user_with_history)
    df = pd.read_csv(StringIO(csv_text))
    assert len(df) == 2
    assert set(db.PREDICTION_COLUMNS) <= set(df.columns)


def test_export_json_parseable(user_with_history):
    payload = json.loads(db.export_predictions_json("pasha", user_with_history))
    assert isinstance(payload, list) and len(payload) == 2
    assert payload[0]["Прогнозований переможець"] in ("Radiant", "Dire")


def test_import_roundtrip(db_path):
    db.add_user("olena", "pass123", db_path)
    df = pd.DataFrame(
        [
            {"Склад Radiant": "A, B, C, D, E", "Склад Dire": "F, G, H, I, J",
             "Шанс Radiant (%)": 58.0, "Шанс Dire (%)": 42.0,
             "Прогнозований переможець": "Radiant"},
            {"Склад Radiant": "H, I, J, K, L", "Склад Dire": "M, N, O, P, Q",
             "Шанс Radiant (%)": 30.0, "Шанс Dire (%)": 70.0,
             "Прогнозований переможець": "Dire"},
        ]
    )
    n = db.import_prediction_history("olena", df, db_path)
    assert n == 2
    history = db.get_prediction_history("olena", db_path)
    assert len(history) == 2
    # Новіші записи сортуються зверху
    assert history.iloc[0]["Прогнозований переможець"] == "Dire"


def test_import_missing_columns_raises(db_path):
    db.add_user("oleh", "x", db_path)
    bad = pd.DataFrame({"Не та колонка": [1]})
    with pytest.raises(ValueError):
        db.import_prediction_history("oleh", bad, db_path)


def test_import_accepts_list_values(db_path):
    db.add_user("nadia", "x", db_path)
    df = pd.DataFrame(
        [
            {"Склад Radiant": ["A", "B", "C", "D", "E"],
             "Склад Dire": ["F", "G", "H", "I", "J"],
             "Шанс Radiant (%)": 50.0, "Шанс Dire (%)": 50.0,
             "Прогнозований переможець": "Нічия"},
        ]
    )
    assert db.import_prediction_history("nadia", df, db_path) == 1
    assert len(db.get_prediction_history("nadia", db_path)) == 1


def test_parse_hero_list_variants():
    assert db.parse_hero_list("A, B, C") == ["A", "B", "C"]
    assert db.parse_hero_list(["X ", " Y"]) == ["X", "Y"]
    assert db.parse_hero_list("") == []