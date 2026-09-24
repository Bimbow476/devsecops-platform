"""Тести розрахунку ймовірності перемоги (dota.predict)."""

import pytest

from dota.predict import compute_prediction

# R = Radiant (середній вінрейт 54.0), D = Dire (середній вінрейт 46.0)
HEROES = {
    "A": {"winrate": 55.0}, "B": {"winrate": 52.0}, "C": {"winrate": 58.0},
    "D": {"winrate": 50.0}, "E": {"winrate": 55.0},
    "F": {"winrate": 46.0}, "G": {"winrate": 48.0}, "H": {"winrate": 44.0},
    "I": {"winrate": 50.0}, "J": {"winrate": 42.0},
}
RAD = ["A", "B", "C", "D", "E"]
DIR = ["F", "G", "H", "I", "J"]


def test_radiant_advantage():
    result = compute_prediction(RAD, DIR, HEROES)
    assert result["rad_chance"] == pytest.approx(54.0)
    assert result["dir_chance"] == pytest.approx(46.0)
    assert result["winner"] == "Radiant"


def test_dire_advantage():
    result = compute_prediction(DIR, RAD, HEROES)
    assert result["rad_chance"] == pytest.approx(46.0)
    assert result["dir_chance"] == pytest.approx(54.0)
    assert result["winner"] == "Dire"


def test_equal_power_is_draw():
    result = compute_prediction(RAD, RAD, HEROES)
    assert result["rad_chance"] == result["dir_chance"] == 50.0
    assert result["winner"] == "Нічия"


def test_avg_winrate_values():
    result = compute_prediction(RAD, DIR, HEROES)
    assert result["rad_avg"] == pytest.approx(54.0)
    assert result["dir_avg"] == pytest.approx(46.0)


def test_detailed_stats_shape():
    result = compute_prediction(RAD, DIR, HEROES)
    assert len(result["rad_stats"]) == 5
    assert len(result["dir_stats"]) == 5
    assert set(result["rad_stats"][0].keys()) == {"Герой", "Вінрейт"}


def test_zero_winrates_do_not_crash():
    zero = {h: {"winrate": 0.0} for h in "ABCDEFGHIJ"}
    result = compute_prediction(RAD, DIR, zero)
    assert result["rad_chance"] == result["dir_chance"] == 50.0
    assert result["winner"] == "Нічия"