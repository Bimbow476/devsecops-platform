"""Розрахунок ймовірності перемоги команд на основі середніх вінрейтів драфту."""


def compute_prediction(radiant_picks, dire_picks, name_to_stats):
    """Рахує шанси Radiant/Dire за середнім вінрейтом обраних героїв.

    Параметри:
        radiant_picks — список з 5 героїв Radiant (назви).
        dire_picks    — список з 5 героїв Dire (назви).
        name_to_stats — словник {назва героя: {"winrate": float}}.
    Повертає dict з деталізацією по кожній команді та підсумковими шансами.
    """
    rad_stats = [{"Герой": h, "Вінрейт": name_to_stats[h]["winrate"]} for h in radiant_picks]
    rad_avg = sum(s["Вінрейт"] for s in rad_stats) / len(rad_stats)

    dir_stats = [{"Герой": h, "Вінрейт": name_to_stats[h]["winrate"]} for h in dire_picks]
    dir_avg = sum(s["Вінрейт"] for s in dir_stats) / len(dir_stats)

    total_power = rad_avg + dir_avg
    if total_power <= 0:
        rad_chance = dir_chance = 50.0
    else:
        rad_chance = round((rad_avg / total_power) * 100, 1)
        dir_chance = round((dir_avg / total_power) * 100, 1)

    if rad_chance > dir_chance:
        predicted_winner = "Radiant"
    elif dir_chance > rad_chance:
        predicted_winner = "Dire"
    else:
        predicted_winner = "Нічия"

    return {
        "rad_stats": rad_stats,
        "dir_stats": dir_stats,
        "rad_avg": rad_avg,
        "dir_avg": dir_avg,
        "rad_chance": rad_chance,
        "dir_chance": dir_chance,
        "winner": predicted_winner,
    }