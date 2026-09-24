# ======================================================================
# Dota 2 Analytics — головний сервіс платформи (Streamlit, Python).
# DevSecOps: slim-образ, оновлення OS-пакетів (зменшує CVE базового
# образу), non-root користувач, HEALTHCHECK + Kubernetes probes.
# Контекст збірки — корінь репозиторію (потрібні app.py і dota/).
# ======================================================================
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/appuser

WORKDIR /app

# Оновлення пакетів ОС — усуває відомі вразливості базового образу
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# Залежності Python в окремому шарі (кешування шарів у CI/CD)
COPY dota/requirements.txt dota/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r dota/requirements.txt

# Рантайм-образ без пакетного менеджера (мінімізація поверхні атаки).
# Побічно прибирає vendored-залежності pip (msgpack==1.1.2, setuptools==70.3.0
# з pip/_vendor/vendor.txt), які Trivy позначає як HIGH, хоча в рантаймі
# вони не використовуються; самі пакети у site-packages — виправлених версій.
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip* \
           /usr/local/bin/pip* \
           /usr/local/bin/wheel* \
           /root/.cache

# Код застосунку
COPY app.py ./
COPY dota ./dota

# Non-root користувач (узгоджується з runAsNonRoot / runAsUser у K8s)
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app /home/appuser

USER appuser

EXPOSE 8501

# Streamlit надає endpoint /_stcore/health — його використовують probes
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8501/_stcore/health', timeout=3).status == 200 else 1)"]

CMD ["streamlit", "run", "app.py", \
     "--server.address=0.0.0.0", \
     "--server.port=8501", \
     "--server.headless=true", \
     "--browser.gatherUsageStats=false"]