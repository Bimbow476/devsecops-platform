import streamlit as st
import requests
import pandas as pd

from dota import db
from dota.predict import compute_prediction

# Налаштування сторінки
st.set_page_config(page_title="Dota 2 Analytics & Predictor", layout="wide")

# Ініціалізація бази даних SQLite (таблиці users та prediction_history)
db.init_db()

# Управління сесією користувача
if "logged_in" not in st.session_state:
    st.session_state.logged_in = False
if "username" not in st.session_state:
    st.session_state.username = ""

# ================= ЕКРАН АВТОРИЗАЦІЇ =================
if not st.session_state.logged_in:
    st.title("Інформаційна система аналітики Dota 2")
    st.write("Будь ласка, увійдіть у систему або зареєструйтесь для продовження роботи.")

    auth_tab1, auth_tab2 = st.tabs(["Вхід", "Реєстрація"])

    with auth_tab1:
        st.subheader("Авторизація")
        login_username = st.text_input("Логін", key="login_user")
        login_password = st.text_input("Пароль", type="password", key="login_pass")
        if st.button("Увійти", use_container_width=True):
            if db.login_user(login_username, login_password):
                st.session_state.logged_in = True
                st.session_state.username = login_username
                st.rerun()
            else:
                st.error("Невірний логін або пароль")

    with auth_tab2:
        st.subheader("Створення нового профілю")
        new_username = st.text_input("Новий логін", key="reg_user")
        new_password = st.text_input("Новий пароль", type="password", key="reg_pass")
        if st.button("Зареєструватися", use_container_width=True):
            if new_username and new_password:
                if db.add_user(new_username, new_password):
                    st.success("Реєстрація успішна! Перейдіть у вкладку 'Вхід' для авторизації.")
                else:
                    st.error("Користувач з таким логіном вже існує.")
            else:
                st.warning("Будь ласка, заповніть всі поля.")

# ================= ГОЛОВНИЙ ЕКРАН ПРОГРАМИ =================
else:
    # Бічна панель з профілем
    st.sidebar.title("Профіль користувача")
    st.sidebar.write(f"Ви увійшли як: **{st.session_state.username}**")
    if st.sidebar.button("Вийти з системи"):
        st.session_state.logged_in = False
        st.session_state.username = ""
        st.rerun()

    # Кешування даних API
    @st.cache_data
    def load_heroes_data():
        url = "https://api.opendota.com/api/heroStats"
        response = requests.get(url)
        heroes_dict = {}
        if response.status_code == 200:
            for hero in response.json():
                icon_path = hero["icon"]
                if not str(icon_path).startswith("http"):
                    icon_url = f"https://cdn.cloudflare.steamstatic.com{icon_path}"
                else:
                    icon_url = icon_path
                pro_pick = hero.get("pro_pick", 0)
                pro_win = hero.get("pro_win", 0)
                winrate = (pro_win / pro_pick * 100) if pro_pick > 0 else 50.0
                heroes_dict[hero["id"]] = {
                    "name": hero["localized_name"],
                    "icon": icon_url,
                    "winrate": round(winrate, 2),
                    "pro_matches": pro_pick
                }
        return heroes_dict

    @st.cache_data
    def load_items_data():
        url = "https://api.opendota.com/api/constants/items"
        response = requests.get(url)
        items_dict = {}
        if response.status_code == 200:
            data = response.json()
            for item_name, item_info in data.items():
                if "id" in item_info and "img" in item_info:
                    icon_path = item_info["img"]
                    if not str(icon_path).startswith("http"):
                        icon_url = f"https://cdn.cloudflare.steamstatic.com{icon_path}"
                    else:
                        icon_url = icon_path
                    items_dict[item_info["id"]] = icon_url
        return items_dict

    heroes_data = load_heroes_data()
    items_data = load_items_data()

    hero_list = sorted([h["name"] for h in heroes_data.values()])
    name_to_stats = {info["name"]: info for info in heroes_data.values()}

    st.title("Аналітика та прогнозування матчів Dota 2")

    tab1, tab2, tab3 = st.tabs(["Аналіз зіграного матчу", "Симулятор драфту (Прогноз)", "Мій архів прогнозів"])

    # Вкладка 1: Аналіз матчу
    with tab1:
        match_id = st.text_input("Введіть ID матчу:", "7500000000")
        if st.button("Проаналізувати матч"):
            with st.spinner("Отримання телеметрії з OpenDota API..."):
                url = f"https://api.opendota.com/api/matches/{match_id}"
                response = requests.get(url)

                if response.status_code == 200:
                    data = response.json()
                    if "error" in data:
                        st.error("Матч не знайдено. Перевірте правильність ID.")
                    else:
                        winner = "Radiant" if data.get("radiant_win") else "Dire"
                        duration_min = data.get("duration", 0) // 60

                        col1, col2, col3 = st.columns(3)
                        col1.metric("Переможець", winner)
                        col2.metric("Тривалість", f"{duration_min} хв")
                        col3.metric("Рахунок (R : D)", f"{data.get('radiant_score', 0)} : {data.get('dire_score', 0)}")
                        st.divider()

                        st.subheader("Динаміка переваги (Radiant Advantage)")
                        col_chart1, col_chart2 = st.columns(2)
                        with col_chart1:
                            st.write("**Золото (Net Worth)**")
                            if "radiant_gold_adv" in data and data["radiant_gold_adv"]:
                                st.area_chart(data["radiant_gold_adv"], color="#FFD700")
                            else:
                                st.info("Графік золота недоступний.")
                        with col_chart2:
                            st.write("**Досвід (XP)**")
                            if "radiant_xp_adv" in data and data["radiant_xp_adv"]:
                                st.area_chart(data["radiant_xp_adv"], color="#1E90FF")
                            else:
                                st.info("Графік досвіду недоступний.")

                        st.divider()
                        st.subheader("Статистика гравців та інвентар")
                        if "players" in data:
                            players_stats = []
                            for p in data["players"]:
                                h_id = p.get("hero_id")
                                h_info = heroes_data.get(h_id, {"name": f"Невідомий ({h_id})", "icon": ""})

                                players_stats.append({
                                    "Команда": "Radiant" if p.get("isRadiant") else "Dire",
                                    "Іконка": h_info["icon"],
                                    "Герой": h_info["name"],
                                    "Рівень": p.get("level"),
                                    "Kills": p.get("kills"),
                                    "Deaths": p.get("deaths"),
                                    "Assists": p.get("assists"),
                                    "Слот 1": items_data.get(p.get("item_0"), ""),
                                    "Слот 2": items_data.get(p.get("item_1"), ""),
                                    "Слот 3": items_data.get(p.get("item_2"), ""),
                                    "Слот 4": items_data.get(p.get("item_3"), ""),
                                    "Слот 5": items_data.get(p.get("item_4"), ""),
                                    "Слот 6": items_data.get(p.get("item_5"), ""),
                                    "Нейтр": items_data.get(p.get("item_neutral"), ""),
                                    "GPM": p.get("gold_per_min"),
                                    "XPM": p.get("xp_per_min"),
                                    "Шкода (Герої)": p.get("hero_damage"),
                                    "Шкода (Будівлі)": p.get("tower_damage")
                                })

                            st.dataframe(pd.DataFrame(players_stats), use_container_width=True, hide_index=True,
                                column_config={
                                    "Іконка": st.column_config.ImageColumn("Фото"),
                                    "Команда": st.column_config.TextColumn("Сторона"),
                                    "Герой": st.column_config.TextColumn("Ім'я"),
                                    "Слот 1": st.column_config.ImageColumn("Слот 1"),
                                    "Слот 2": st.column_config.ImageColumn("Слот 2"),
                                    "Слот 3": st.column_config.ImageColumn("Слот 3"),
                                    "Слот 4": st.column_config.ImageColumn("Слот 4"),
                                    "Слот 5": st.column_config.ImageColumn("Слот 5"),
                                    "Слот 6": st.column_config.ImageColumn("Слот 6"),
                                    "Нейтр": st.column_config.ImageColumn("Нейтр")
                                }
                            )
                else:
                    st.error("Помилка з'єднання з сервером API.")

    # Вкладка 2: Симулятор драфту
    with tab2:
        st.markdown("### Аналіз ймовірності перемоги на основі глобальної статистики")
        col_rad, col_dir = st.columns(2)
        with col_rad:
            st.subheader("Команда Radiant")
            radiant_picks = st.multiselect("Оберіть 5 героїв:", hero_list, max_selections=5, key="rad_picks")
        with col_dir:
            st.subheader("Команда Dire")
            dire_picks = st.multiselect("Оберіть 5 героїв:", hero_list, max_selections=5, key="dir_picks")

        st.divider()
        if len(radiant_picks) == 5 and len(dire_picks) == 5:
            common_heroes = set(radiant_picks).intersection(set(dire_picks))
            if common_heroes:
                st.warning(f"Увага! Герої не можуть бути в обох командах одночасно: {', '.join(common_heroes)}")
            else:
                if st.button("Провести статистичний аналіз", use_container_width=True):
                    with st.spinner("Аналіз вінрейтів з бази даних..."):
                        result = compute_prediction(radiant_picks, dire_picks, name_to_stats)
                        rad_stats = result["rad_stats"]
                        dir_stats = result["dir_stats"]
                        rad_avg_winrate = result["rad_avg"]
                        dir_avg_winrate = result["dir_avg"]
                        rad_chance = result["rad_chance"]
                        dir_chance = result["dir_chance"]
                        predicted_winner = result["winner"]

                        # ЗБЕРЕЖЕННЯ У БАЗУ З ПРИВ'ЯЗКОЮ ДО ПОТОЧНОГО КОРИСТУВАЧА
                        db.save_prediction(st.session_state.username, radiant_picks, dire_picks, rad_chance, dir_chance, predicted_winner)

                        st.markdown("### Результати розрахунку:")
                        if rad_chance > 50:
                            st.success(f"Математична перевага на стороні Radiant ({rad_chance}%)")
                        elif dir_chance > 50:
                            st.error(f"Математична перевага на стороні Dire ({dir_chance}%)")
                        else:
                            st.warning("Сили абсолютно рівні (50% на 50%)")

                        st.progress(rad_chance / 100.0)

                        col_res1, col_res2 = st.columns(2)
                        col_res1.metric("Ймовірність Radiant", f"{rad_chance}%", f"Середній вінрейт команди: {round(rad_avg_winrate, 1)}%")
                        col_res2.metric("Ймовірність Dire", f"{dir_chance}%", f"Середній вінрейт команди: {round(dir_avg_winrate, 1)}%")

                        st.markdown("#### Деталізація сили драфту:")
                        col_table1, col_table2 = st.columns(2)
                        with col_table1:
                            st.dataframe(pd.DataFrame(rad_stats), hide_index=True, use_container_width=True)
                        with col_table2:
                            st.dataframe(pd.DataFrame(dir_stats), hide_index=True, use_container_width=True)
        else:
            st.info("Будь ласка, оберіть рівно по 5 героїв для кожної команди, щоб зробити прогноз.")

    # Вкладка 3: Персональна історія прогнозів
    with tab3:
        st.markdown(f"### Архів симуляцій користувача: {st.session_state.username}")
        st.write("Тут відображаються лише ваші особисті збережені прогнози.")

        history_df = db.get_prediction_history(st.session_state.username)

        if not history_df.empty:
            st.dataframe(history_df, use_container_width=True, hide_index=True)
            st.divider()
            if st.button("Очистити мій архів прогнозів"):
                db.clear_prediction_history(st.session_state.username)
                st.success("Вашу персональну історію успішно очищено!")
                st.rerun()
        else:
            st.info("Ваша історія симуляцій порожня. Зробіть свій перший прогноз!")