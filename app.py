import streamlit as st
import requests
import pandas as pd

from dota import db
from dota import client as pclient
from dota import security as sec_report
from dota.predict import compute_prediction

# Налаштування сторінки
st.set_page_config(
    page_title="Dota 2 Analytics & DevSecOps Platform", layout="wide"
)

# Ініціалізація бази даних SQLite (таблиці users та prediction_history)
db.init_db()

# Управління сесією користувача
if "logged_in" not in st.session_state:
    st.session_state.logged_in = False
if "username" not in st.session_state:
    st.session_state.username = ""

# Стійкий HTTP-клієнт платформи (gateway/metrics/data)
client = pclient.PlatformClient()


# ================= КЕШУВАННЯ ДАНИХ ЗОВНІШНЬОГО API (OpenDota) =================
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


# ================= ПУБЛІЧНИЙ ТАБ: МОНІТОРИНГ ПЛАТФОРМИ =================
def render_monitoring(pl_client: pclient.PlatformClient) -> None:
    st.markdown("### Стан мікросервісної платформи")
    st.caption(
        "Агрегований статус gateway/metrics/data через /api/status; "
        "клієнт-серверна взаємодія з ретраями та кешем last-known-good."
    )
    if st.button("🔄 Оновити дані", key="mon_refresh"):
        pl_client.invalidate()
        st.rerun()

    try:
        snapshots = pl_client.platform_status()
    except pclient.PlatformUnavailable:
        snapshots = []
        st.error(
            "Шлюз gateway не відповідає. Застосунок має працювати в кластері "
            "(http://gateway:8080) або DOTA_API_URL має вказувати на порт-forward."
        )

    if snapshots:
        cols = st.columns(len(snapshots))
        for col, snap in zip(cols, snapshots):
            with col:
                if snap.healthy:
                    st.success(f"✅ {snap.name}")
                else:
                    st.error(f"❌ {snap.name}")
                st.metric("Статус", snap.status)
                st.metric("Версія", snap.version)
                st.metric("Затримка", f"{snap.latency_ms:.0f} мс")

    frontend_ok = pl_client.frontend_reachable()
    if frontend_ok:
        st.success("✅ React-дашборд (frontend): доступний")
    else:
        st.warning("⚠️ React-дашборд (frontend): недоступний")

    if pl_client.degraded:
        st.warning("⚠️ Режим деградації: частина сервісів недоступна, задіяний кеш.")
    if pl_client.stale_served:
        st.info("Відображено кешовані дані (стійкість: stale-while-revalidate).")

    st.markdown("### Метрики системи (metrics-сервіс)")
    try:
        m = pl_client.system_metrics()
        col1, col2, col3, col4 = st.columns(4)
        col1.metric("Хост", m["hostname"])
        col2.metric("Платформа", f'{m["platform"]} / {m["arch"]}')
        col3.metric("CPU (ядер)", m["cpu"]["cores"])
        col4.metric("Пам'ять", f'{m["memory"]["usagePercent"]}%')
        st.progress(min(m["memory"]["usagePercent"] / 100.0, 1.0))
        st.write("**Завантаження ядер CPU, %:**")
        cpu_df = pd.DataFrame(
            {
                "Ядро #": [f"#{i + 1}" for i in range(len(m["cpu"]["usagePerCore"]))],
                "Завантаження %": m["cpu"]["usagePerCore"],
            }
        )
        st.bar_chart(cpu_df.set_index("Ядро #"))
        st.caption(
            "Load average: "
            + ", ".join(f"{v:.2f}" for v in m.get("loadavg", []))
        )
    except pclient.PlatformUnavailable:
        st.info("Метрики системи недоступні (сервіс metrics не відповідає).")

    with st.expander("ℹ️ Про стійкість клієнт-серверної взаємодії"):
        st.write(
            "Запити до платформи виконуються через стійкий HTTP-клієнт "
            f"(dota/client.py): таймаут {pl_client.timeout} с, ретраї ×{pl_client.max_retries} "
            f"з експоненційним бек-офом, кеш last-known-good (TTL {pl_client.cache_ttl} с) "
            "та режим деградації при послідовних відмовах — демонстрація вимоги "
            "«стійка клієнт-серверна взаємодія»."
        )


# ================= ПУБЛІЧНИЙ ТАБ: УПРАВЛІННЯ ДАНИМИ =================
def render_data(pl_client: pclient.PlatformClient) -> None:
    st.markdown("### Записи платформи (data-сервіс через gateway)")
    st.caption("CRUD через REST API мікросервісу data: /api/data/records")

    col_a, col_b = st.columns(2)
    with col_a:
        search_q = st.text_input("Пошук (назва/опис)", key="rec_search")
    with col_b:
        status_f = st.selectbox(
            "Статус",
            ["", "new", "in_progress", "done", "archived"],
            key="rec_status",
        )

    try:
        result = pl_client.list_records(search=search_q, status=status_f, limit=100)
        items = result.get("items", [])
        total = result.get("total", len(items))
        st.caption(f"Знайдено записів: {total}")
        if items:
            display = pd.DataFrame(items)[
                ["id", "title", "description", "status", "priority", "updated_at"]
            ]
            st.dataframe(display, use_container_width=True, hide_index=True)
        else:
            st.info("Записів немає.")
    except pclient.PlatformUnavailable:
        st.error("Сервіс даних недоступний.")

    col_c, col_d = st.columns(2)
    with col_c:
        with st.expander("➕ Додати запис"):
            title = st.text_input("Назва запису", key="rec_title")
            desc = st.text_area("Опис", key="rec_desc")
            st_s, st_p = st.columns(2)
            status_new = st_s.selectbox(
                "Статус", ["new", "in_progress", "done", "archived"], key="rec_new_status"
            )
            priority_new = st_p.slider("Пріоритет (1-5)", 1, 5, 3, key="rec_priority")
            if st.button("Створити запис", key="rec_create"):
                if title.strip():
                    try:
                        pl_client.create_record(
                            title.strip(), desc.strip() or None, status_new, priority_new
                        )
                        st.success("Запис створено.")
                        st.rerun()
                    except pclient.PlatformUnavailable:
                        st.error("Не вдалося створити запис: сервіс недоступний.")
                else:
                    st.warning("Вкажіть назву запису.")
    with col_d:
        with st.expander("🗑️ Видалити запис"):
            rec_id = st.number_input("ID запису", min_value=1, step=1, key="rec_del_id")
            if st.button("Видалити", key="rec_del"):
                try:
                    if pl_client.delete_record(int(rec_id)):
                        st.info(f"Запис #{rec_id} видалено.")
                        st.rerun()
                    else:
                        st.warning(f"Запис #{rec_id} не знайдено.")
                except pclient.PlatformUnavailable:
                    st.error("Не вдалося видалити: сервіс недоступний.")

    # Експорт/імпорт персональних прогнозів (вимагає входу)
    if st.session_state.logged_in:
        st.divider()
        st.markdown(f"### Мої прогнози ({st.session_state.username})")
        st.caption("Експорт/імпорт персональної історії прогнозів (власна SQLite).")
        col_e, col_f = st.columns(2)
        with col_e:
            st.download_button(
                "⬇️ Експорт CSV",
                data=db.export_predictions_csv(st.session_state.username),
                file_name=f"dota_history_{st.session_state.username}.csv",
                mime="text/csv",
                key="exp_csv",
            )
            st.download_button(
                "⬇️ Експорт JSON",
                data=db.export_predictions_json(st.session_state.username),
                file_name=f"dota_history_{st.session_state.username}.json",
                mime="application/json",
                key="exp_json",
            )
        with col_f:
            uploaded = st.file_uploader(
                "Імпортувати CSV прогнозів", type=["csv"], key="imp_csv"
            )
            if uploaded is not None:
                df_in = pd.read_csv(uploaded)
                try:
                    n_imported = db.import_prediction_history(
                        st.session_state.username, df_in
                    )
                    st.success(f"Імпортовано записів: {n_imported}")
                    st.rerun()
                except ValueError as exc:
                    st.error(str(exc))


# ================= ПУБЛІЧНИЙ ТАБ: БЕЗПЕКА / DEVSECOPS =================
def render_security() -> None:
    st.markdown("### Проактивний контроль вразливостей (DevSecOps)")
    st.caption(
        "⚠️ Змодельований звіт (рандомна генерація для демонстрації). "
        "Реальні результати генеруються в CI/CD: Trivy, CodeQL, "
        "pip-audit, npm audit та Dependabot."
    )

    if "sec_report" not in st.session_state:
        st.session_state.sec_report = sec_report.generate_security_report()

    if st.button("🎲 Згенерувати новий звіт"):
        st.session_state.sec_report = sec_report.generate_security_report()
        st.rerun()

    report = st.session_state.sec_report
    score = sec_report.security_score(report)

    total_critical = sum(s["trivy"]["critical"] for s in report["services"])
    total_high = sum(s["trivy"]["high"] for s in report["services"])
    open_alerts = sum(1 for a in report["alerts"] if a["status"] == "open")
    ok_workflows = sum(1 for w in report["workflows"] if w["status"] == "success")
    n_workflows = len(report["workflows"])

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("CRITICAL (образи)", total_critical)
    col2.metric("HIGH (образи)", total_high)
    col3.metric("Відкриті алерти залежностей", open_alerts)
    col4.metric("Workflows ✓", f"{ok_workflows}/{n_workflows}")

    st.write("**Оцінка безпеки платформи (демо):**")
    st.progress(score / 100.0)

    st.markdown("#### Сканування Docker-образів (Trivy)")
    trivy_df = pd.DataFrame(
        [
            {
                "Сервіс": s["service"],
                "Образ": s["image_tag"],
                "CRITICAL": s["trivy"]["critical"],
                "HIGH": s["trivy"]["high"],
                "MEDIUM": s["trivy"]["medium"],
                "LOW": s["trivy"]["low"],
                "Останній скан": f"{s['last_scan_minutes_ago']} хв тому",
            }
            for s in report["services"]
        ]
    )
    st.dataframe(trivy_df, use_container_width=True, hide_index=True)

    st.markdown("#### Алерти залежностей (Dependabot)")
    st.dataframe(
        pd.DataFrame(report["alerts"]), use_container_width=True, hide_index=True
    )

    st.markdown("#### Запуски пайплайну (GitHub Actions)")
    wf_df = pd.DataFrame(
        [
            {
                "Workflow": w["name"],
                "Статус": "✅" if w["status"] == "success" else "❌",
                "Тривалість": f"{w['duration_sec']} с",
                "Тригер": w["trigger"],
            }
            for w in report["workflows"]
        ]
    )
    st.dataframe(wf_df, use_container_width=True, hide_index=True)

    with st.expander("🔒 Практики безпеки, впроваджені в платформі"):
        practices = [
            "Non-root контейнери (runAsNonRoot, uid 1000) у всіх сервісах",
            "Liveness/readiness probes та HEALTHCHECK в образах",
            "Мінімальний runtime-образ Dota: без pip та lockfile",
            "Trivy-сканування образів у CI з порогом 0 CRITICAL/HIGH",
            "CodeQL — статичний аналіз Python + JavaScript/TypeScript",
            "Dependabot — алерти на вразливості залежностей та авто-PR",
            "pip-audit та npm audit у конвеєрі",
            "Харднінг OS-пакетів бази (apt upgrade), видалення apt lists",
        ]
        st.write("\n".join(f"- {p}" for p in practices))


# ================= БІЧНА ПАНЕЛЬ: ПРОФІЛЬ / ВХІД =================
with st.sidebar:
    st.title("Профіль")
    if st.session_state.logged_in:
        st.write(f"Ви увійшли як: **{st.session_state.username}**")
        if st.sidebar.button("Вийти з системи"):
            st.session_state.logged_in = False
            st.session_state.username = ""
            st.rerun()
    else:
        st.caption("Вхід потрібен лише для розділу аналітики Dota 2.")
        with st.expander("Вхід", expanded=True):
            login_username = st.text_input("Логін", key="login_user")
            login_password = st.text_input("Пароль", type="password", key="login_pass")
            if st.button("Увійти", use_container_width=True):
                if db.login_user(login_username, login_password):
                    st.session_state.logged_in = True
                    st.session_state.username = login_username
                    st.rerun()
                else:
                    st.error("Невірний логін або пароль")
        with st.expander("Реєстрація"):
            new_username = st.text_input("Новий логін", key="reg_user")
            new_password = st.text_input("Новий пароль", type="password", key="reg_pass")
            if st.button("Зареєструватися", use_container_width=True):
                if new_username and new_password:
                    if db.add_user(new_username, new_password):
                        st.success("Реєстрація успішна! Перейдіть у вкладку «Вхід».")
                    else:
                        st.error("Користувач з таким логіном вже існує.")
                else:
                    st.warning("Будь ласка, заповніть всі поля.")


# ================= ГОЛОВНИЙ ВМІСТ =================
st.title("Інформаційна система аналітики Dota 2")
st.caption(
    "Головний сервіс мікросервісної DevSecOps-платформи. "
    "Публічні розділи: моніторинг платформи, управління даними та "
    "контроль вразливостей. Аналітика матчів — після входу."
)

tab_mon, tab_data, tab_sec = st.tabs(
    ["📊 Моніторинг платформи", "🗄️ Управління даними", "🛡️ Безпека / DevSecOps"]
)

with tab_mon:
    render_monitoring(client)

with tab_data:
    render_data(client)

with tab_sec:
    render_security()


# ================= АНАЛІТИКА (ПІСЛЯ ВХОДУ) =================
if st.session_state.logged_in:
    st.divider()
    st.subheader("Аналітика матчів Dota 2")

    heroes_data = load_heroes_data()
    items_data = load_items_data()

    hero_list = sorted([h["name"] for h in heroes_data.values()])
    name_to_stats = {info["name"]: info for info in heroes_data.values()}

    tab1, tab2, tab3 = st.tabs(
        ["Аналіз зіграного матчу", "Симулятор драфту (Прогноз)", "Мій архів прогнозів"]
    )

    # ---------------- Вкладка 1: Аналіз матчу ----------------
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
                        col3.metric(
                            "Рахунок (R : D)",
                            f"{data.get('radiant_score', 0)} : {data.get('dire_score', 0)}",
                        )
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
                                h_info = heroes_data.get(
                                    h_id, {"name": f"Невідомий ({h_id})", "icon": ""}
                                )

                                players_stats.append(
                                    {
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
                                        "Шкода (Будівлі)": p.get("tower_damage"),
                                    }
                                )

                            st.dataframe(
                                pd.DataFrame(players_stats),
                                use_container_width=True,
                                hide_index=True,
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
                                    "Нейтр": st.column_config.ImageColumn("Нейтр"),
                                },
                            )
                else:
                    st.error("Помилка з'єднання з сервером API.")

    # ---------------- Вкладка 2: Симулятор драфту ----------------
    with tab2:
        st.markdown("### Аналіз ймовірності перемоги на основі глобальної статистики")
        col_rad, col_dir = st.columns(2)
        with col_rad:
            st.subheader("Команда Radiant")
            radiant_picks = st.multiselect(
                "Оберіть 5 героїв:", hero_list, max_selections=5, key="rad_picks"
            )
        with col_dir:
            st.subheader("Команда Dire")
            dire_picks = st.multiselect(
                "Оберіть 5 героїв:", hero_list, max_selections=5, key="dir_picks"
            )

        st.divider()
        if len(radiant_picks) == 5 and len(dire_picks) == 5:
            common_heroes = set(radiant_picks).intersection(set(dire_picks))
            if common_heroes:
                st.warning(
                    f"Увага! Герої не можуть бути в обох командах одночасно: "
                    f"{', '.join(common_heroes)}"
                )
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
                        db.save_prediction(
                            st.session_state.username,
                            radiant_picks,
                            dire_picks,
                            rad_chance,
                            dir_chance,
                            predicted_winner,
                        )

                        st.markdown("### Результати розрахунку:")
                        if rad_chance > 50:
                            st.success(
                                f"Математична перевага на стороні Radiant ({rad_chance}%)"
                            )
                        elif dir_chance > 50:
                            st.error(
                                f"Математична перевага на стороні Dire ({dir_chance}%)"
                            )
                        else:
                            st.warning("Сили абсолютно рівні (50% на 50%)")

                        st.progress(rad_chance / 100.0)

                        col_res1, col_res2 = st.columns(2)
                        col_res1.metric(
                            "Ймовірність Radiant",
                            f"{rad_chance}%",
                            f"Середній вінрейт команди: {round(rad_avg_winrate, 1)}%",
                        )
                        col_res2.metric(
                            "Ймовірність Dire",
                            f"{dir_chance}%",
                            f"Середній вінрейт команди: {round(dir_avg_winrate, 1)}%",
                        )

                        st.markdown("#### Деталізація сили драфту:")
                        col_table1, col_table2 = st.columns(2)
                        with col_table1:
                            st.dataframe(
                                pd.DataFrame(rad_stats),
                                hide_index=True,
                                use_container_width=True,
                            )
                        with col_table2:
                            st.dataframe(
                                pd.DataFrame(dir_stats),
                                hide_index=True,
                                use_container_width=True,
                            )
        else:
            st.info(
                "Будь ласка, оберіть рівно по 5 героїв для кожної команди, "
                "щоб зробити прогноз."
            )

    # ---------------- Вкладка 3: Персональна історія прогнозів ----------------
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