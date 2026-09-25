import streamlit as st
import requests
import pandas as pd

from dota import db
from dota import client as pclient
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


# ================= ПУБЛІЧНИЙ ТАБ: УПРАВЛІННЯ ПРОЄКТАМИ =================
PROJECT_STATUS_LABELS = {
    "planned": "Запланований",
    "active": "Активний",
    "blocked": "Заблокований",
    "completed": "Завершений",
    # Можливий лише для даних, перенесених зі старого records-контракту.
    "archived": "Архівований (стара система)",
}
PROJECT_STATUS_OPTIONS = [
    status for status in PROJECT_STATUS_LABELS if status != "archived"
]
PROJECT_FILTER_OPTIONS = ["", *PROJECT_STATUS_LABELS]
TASK_STATUS_LABELS = {
    "todo": "До розподілу",
    "in_progress": "У роботі",
    "done": "Готово",
}


def _optional_text(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    return cleaned or None


def _project_status_label(status: str) -> str:
    return PROJECT_STATUS_LABELS.get(status, status)


def _project_form_status(status: str) -> str:
    """Переводить legacy-статус у форму, дозволену поточним API."""
    return status if status in PROJECT_STATUS_OPTIONS else "completed"


def _task_status_label(status: str) -> str:
    return TASK_STATUS_LABELS.get(status, status)


def render_projects(pl_client: pclient.PlatformClient) -> None:
    st.markdown("### Проєкти та задачі")
    st.caption(
        "Джерело даних — REST API мікросервісу data через gateway. "
        "Прогрес рахується з виконаних задач, а не генерується."
    )

    if st.button("🔄 Оновити проєкти", key="projects_refresh"):
        pl_client.invalidate()
        st.rerun()

    col_search, col_status = st.columns([2, 1])
    with col_search:
        search_q = st.text_input("Пошук проєкту", key="project_search")
    with col_status:
        status_f = st.selectbox(
            "Статус проєкту",
            PROJECT_FILTER_OPTIONS,
            format_func=lambda value: value if not value else _project_status_label(value),
            key="project_status_filter",
        )

    try:
        result = pl_client.list_all_projects(
            search=search_q, status=status_f, page_size=100
        )
        projects = result.get("items", [])
        total = int(result.get("total", len(projects)))
    except pclient.PlatformUnavailable:
        st.error("Сервіс проєктів недоступний.")
        return

    active_count = sum(p.get("status") == "active" for p in projects)
    completed_count = sum(p.get("status") == "completed" for p in projects)
    avg_progress = (
        sum(float(p.get("progress_percent", 0)) for p in projects) / len(projects)
        if projects
        else 0
    )
    metric_cols = st.columns(4)
    metric_cols[0].metric("Проєктів", total)
    metric_cols[1].metric("Активних", active_count)
    metric_cols[2].metric("Завершених", completed_count)
    metric_cols[3].metric("Середній прогрес", f"{avg_progress:.0f}%")

    with st.expander("➕ Створити проєкт", expanded=not projects):
        with st.form("project_create_form", clear_on_submit=True):
            name = st.text_input("Назва проєкту *", max_chars=120)
            description = st.text_area("Опис", max_chars=2000)
            form_cols = st.columns(3)
            new_status = form_cols[0].selectbox(
                "Статус",
                list(PROJECT_STATUS_OPTIONS),
                format_func=_project_status_label,
            )
            new_priority = form_cols[1].slider("Пріоритет (1–5)", 1, 5, 3)
            owner = form_cols[2].text_input("Відповідальний")
            due_date = st.text_input(
                "Дедлайн (YYYY-MM-DD)", placeholder="наприклад, 2026-12-31"
            )
            submitted = st.form_submit_button("Створити проєкт", type="primary")

        if submitted:
            if not name.strip():
                st.warning("Вкажіть назву проєкту.")
            else:
                try:
                    pl_client.create_project(
                        name.strip(),
                        _optional_text(description),
                        new_status,
                        new_priority,
                        _optional_text(owner),
                        _optional_text(due_date),
                    )
                    st.success("Проєкт створено.")
                    st.rerun()
                except pclient.PlatformUnavailable as exc:
                    st.error(f"Не вдалося створити проєкт: {exc}")

    if not projects:
        st.info("Проєктів поки немає. Створіть перший проєкт або змініть фільтри.")
        return

    project_by_id = {int(project["id"]): project for project in projects}
    selected_id = st.selectbox(
        "Обраний проєкт",
        options=list(project_by_id),
        format_func=lambda project_id: (
            f"#{project_id} · {project_by_id[project_id]['name']}"
        ),
        key="selected_project_id",
    )
    selected = project_by_id[selected_id]

    st.subheader(selected["name"])
    st.caption(selected.get("description") or "Опис проєкту не вказано.")
    progress = float(selected.get("progress_percent", 0))
    st.progress(min(max(progress / 100.0, 0.0), 1.0))
    st.caption(
        f"Статус: {_project_status_label(selected['status'])} · "
        f"Пріоритет: {selected['priority']}/5 · "
        f"Задачі: {selected.get('completed_task_count', 0)}/"
        f"{selected.get('task_count', 0)} · Прогрес: {progress:.0f}%"
    )
    owner = selected.get("owner")
    due_date = selected.get("due_date")
    if owner or due_date:
        st.caption(
            " · ".join(
                part
                for part in (
                    f"Відповідальний: {owner}" if owner else "",
                    f"Дедлайн: {due_date}" if due_date else "",
                )
                if part
            )
        )

    if selected["status"] == "archived":
        st.info(
            "ℹ️ Це legacy-архівований проєкт: доступний для перегляду, "
            "але недоступний для редагування."
        )
    else:
        with st.expander("✏️ Редагувати проєкт"):
            with st.form(f"project_edit_{selected_id}"):
                edit_name = st.text_input("Назва", value=selected["name"], max_chars=120)
                edit_description = st.text_area(
                    "Опис", value=selected.get("description") or ""
                )
                edit_cols = st.columns(3)
                edit_status = edit_cols[0].selectbox(
                    "Статус",
                    list(PROJECT_STATUS_OPTIONS),
                    index=list(PROJECT_STATUS_OPTIONS).index(
                        _project_form_status(selected["status"])
                    ),
                    format_func=_project_status_label,
                )
                edit_priority = edit_cols[1].slider(
                    "Пріоритет", 1, 5, int(selected["priority"])
                )
                edit_owner = edit_cols[2].text_input(
                    "Відповідальний", value=selected.get("owner") or ""
                )
                edit_due = st.text_input("Дедлайн (YYYY-MM-DD)", value=due_date or "")
                save_project = st.form_submit_button("Зберегти зміни")

            if save_project:
                if not edit_name.strip():
                    st.warning("Назва проєкту не може бути порожньою.")
                else:
                    try:
                        pl_client.update_project(
                            selected_id,
                            {
                                "name": edit_name.strip(),
                                "description": _optional_text(edit_description),
                                "status": edit_status,
                                "priority": int(edit_priority),
                                "owner": _optional_text(edit_owner),
                                "due_date": _optional_text(edit_due),
                            },
                        )
                        st.success("Проєкт оновлено.")
                        st.rerun()
                    except pclient.PlatformUnavailable as exc:
                        st.error(f"Не вдалося оновити проєкт: {exc}")

    if selected["status"] != "archived":
        confirm_project_delete = st.checkbox(
            "Підтверджую видалення проєкту разом із задачами",
            key=f"confirm_project_delete_{selected_id}",
        )
        if st.button(
            "🗑️ Видалити проєкт",
            disabled=not confirm_project_delete,
            key=f"delete_project_{selected_id}",
        ):
            try:
                if pl_client.delete_project(selected_id):
                    st.success("Проєкт видалено.")
                    st.rerun()
                else:
                    st.warning("Проєкт уже не існує.")
                    st.rerun()
            except pclient.PlatformUnavailable as exc:
                st.error(f"Не вдалося видалити проєкт: {exc}")

    st.divider()
    st.subheader("Задачі проєкту")
    try:
        tasks = pl_client.list_all_tasks(selected_id)
    except pclient.PlatformUnavailable:
        st.error("Не вдалося завантажити задачі проєкту.")
        return

    done_count = sum(task.get("status") == "done" for task in tasks)
    st.caption(f"Виконано {done_count} із {len(tasks)} задач.")

    if selected["status"] != "archived":
        with st.expander("➕ Додати задачу"):
            with st.form(f"task_create_{selected_id}", clear_on_submit=True):
                task_title = st.text_input("Назва задачі *", max_chars=160)
                task_description = st.text_area("Опис", max_chars=2000)
                task_cols = st.columns(3)
                task_status = task_cols[0].selectbox(
                    "Статус", list(TASK_STATUS_LABELS), format_func=_task_status_label
                )
                task_priority = task_cols[1].slider("Пріоритет (1–5)", 1, 5, 3)
                assignee = task_cols[2].text_input("Виконавець")
                task_due = st.text_input("Дедлайн (YYYY-MM-DD)")
                create_task = st.form_submit_button("Додати задачу", type="primary")

            if create_task:
                if not task_title.strip():
                    st.warning("Вкажіть назву задачі.")
                else:
                    try:
                        pl_client.create_task(
                            selected_id,
                            task_title.strip(),
                            _optional_text(task_description),
                            task_status,
                            task_priority,
                            _optional_text(assignee),
                            _optional_text(task_due),
                        )
                        st.success("Задачу додано.")
                        st.rerun()
                    except pclient.PlatformUnavailable as exc:
                        st.error(f"Не вдалося додати задачу: {exc}")

    if tasks:
        task_rows = [
            {
                "ID": task["id"],
                "Задача": task["title"],
                "Статус": _task_status_label(task["status"]),
                "Пріоритет": task["priority"],
                "Виконавець": task.get("assignee") or "—",
                "Дедлайн": task.get("due_date") or "—",
            }
            for task in tasks
        ]
        st.dataframe(pd.DataFrame(task_rows), use_container_width=True, hide_index=True)

        if selected["status"] != "archived":
            task_by_id = {int(task["id"]): task for task in tasks}
            task_to_edit = st.selectbox(
                "Задача для редагування",
                options=list(task_by_id),
                format_func=lambda task_id: f"#{task_id} · {task_by_id[task_id]['title']}",
                key=f"task_to_edit_{selected_id}",
            )
            task = task_by_id[task_to_edit]
            with st.expander("✏️ Редагувати задачу"):
                with st.form(f"task_edit_{task_to_edit}"):
                    edit_task_title = st.text_input(
                        "Назва", value=task["title"], max_chars=160
                    )
                    edit_task_description = st.text_area(
                        "Опис", value=task.get("description") or ""
                    )
                    edit_task_cols = st.columns(3)
                    edit_task_status = edit_task_cols[0].selectbox(
                        "Статус",
                        list(TASK_STATUS_LABELS),
                        index=list(TASK_STATUS_LABELS).index(task["status"]),
                        format_func=_task_status_label,
                    )
                    edit_task_priority = edit_task_cols[1].slider(
                        "Пріоритет", 1, 5, int(task["priority"])
                    )
                    edit_assignee = edit_task_cols[2].text_input(
                        "Виконавець", value=task.get("assignee") or ""
                    )
                    edit_task_due = st.text_input(
                        "Дедлайн (YYYY-MM-DD)", value=task.get("due_date") or ""
                    )
                    save_task = st.form_submit_button("Зберегти задачу")

                if save_task:
                    if not edit_task_title.strip():
                        st.warning("Назва задачі не може бути порожньою.")
                    else:
                        try:
                            pl_client.update_task(
                                task_to_edit,
                                {
                                    "title": edit_task_title.strip(),
                                    "description": _optional_text(edit_task_description),
                                    "status": edit_task_status,
                                    "priority": int(edit_task_priority),
                                    "assignee": _optional_text(edit_assignee),
                                    "due_date": _optional_text(edit_task_due),
                                },
                            )
                            st.success("Задачу оновлено.")
                            st.rerun()
                        except pclient.PlatformUnavailable as exc:
                            st.error(f"Не вдалося оновити задачу: {exc}")

            confirm_task_delete = st.checkbox(
                "Підтверджую видалення обраної задачі",
                key=f"confirm_task_delete_{task_to_edit}",
            )
            if st.button(
                "🗑️ Видалити обрану задачу",
                disabled=not confirm_task_delete,
                key=f"delete_task_{task_to_edit}",
            ):
                try:
                    if pl_client.delete_task(task_to_edit):
                        st.success("Задачу видалено.")
                        st.rerun()
                    else:
                        st.warning("Задача уже не існує.")
                        st.rerun()
                except pclient.PlatformUnavailable as exc:
                    st.error(f"Не вдалося видалити задачу: {exc}")
    elif selected["status"] != "archived":
        st.info("У цьому проєкті ще немає задач. Додайте першу задачу.")
    else:
        st.info("У legacy-проєкті немає задач для перегляду.")


def render_prediction_archive(username: str) -> None:
    """Персональний архів прогнозів не пов'язаний із проєктами платформи."""
    st.divider()
    st.markdown("### Експорт та імпорт прогнозів")
    st.caption("Персональні дані зберігаються окремо від проєктів у власній SQLite.")
    col_export, col_import = st.columns(2)
    with col_export:
        st.download_button(
            "⬇️ Експорт CSV",
            data=db.export_predictions_csv(username),
            file_name=f"dota_history_{username}.csv",
            mime="text/csv",
            key="exp_csv",
        )
        st.download_button(
            "⬇️ Експорт JSON",
            data=db.export_predictions_json(username),
            file_name=f"dota_history_{username}.json",
            mime="application/json",
            key="exp_json",
        )
    with col_import:
        uploaded = st.file_uploader("Імпортувати CSV прогнозів", type=["csv"], key="imp_csv")
        if uploaded is not None:
            df_in = pd.read_csv(uploaded)
            try:
                imported = db.import_prediction_history(username, df_in)
                st.success(f"Імпортовано записів: {imported}")
                st.rerun()
            except ValueError as exc:
                st.error(str(exc))



# ================= СТОРІНКА 1 (ГОЛОВНА): АНАЛІТИКА DOTA 2 =================
def page_analytics() -> None:
    st.title("Інформаційна система аналітики Dota 2")
    st.caption(
        "Головна сторінка головного сервісу платформи: аналіз зіграних матчів "
        "через OpenDota API, симулятор драфту (прогноз переможця за вінрейтами) "
        "та персональний архів прогнозів. Розділ доступний після входу."
    )

    if not st.session_state.logged_in:
        st.info(
            "🔒 Аналітика Dota 2 доступна після входу. Зареєструйтеся та увійдіть "
            "у бічній панелі зліва (розділи «Вхід» / «Реєстрація»)."
        )
        return

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

        render_prediction_archive(st.session_state.username)


# ================= СТОРІНКА 2: МІЖСЕРВІСНА ПЛАТФОРМА =================
def page_platform() -> None:
    st.title("Міжсервісна платформа")
    st.caption(
        "Публічні розділи головного сервісу (доступні без входу): моніторинг "
        "мікросервісної платформи та керування проєктами й задачами."
    )

    tab_mon, tab_projects = st.tabs(
        ["📊 Моніторинг платформи", "🗂️ Управління проєктами"]
    )

    with tab_mon:
        render_monitoring(client)

    with tab_projects:
        render_projects(client)


# ================= НАВІГАЦІЯ МІЖ СТОРІНКАМИ =================
pg = st.navigation(
    [
        st.Page(page_analytics, title="Аналітика Dota 2", icon="🎮", default=True),
        st.Page(page_platform, title="Міжсервісна платформа", icon="🛠"),
    ]
)
pg.run()


# ================= БІЧНА ПАНЕЛЬ: ПРОФІЛЬ / ВХІД (спільна для обох сторінок) =================
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