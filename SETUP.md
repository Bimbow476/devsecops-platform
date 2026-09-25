# ⚙️ SETUP — підготовка середовища

Покрокова інструкція встановлення всього необхідного для локального кластера
(Minikube) та конвеєра DevSecOps (GitHub Actions + Dependabot).

---

## 1. Віртуалізація (обов'язково для Minikube)

Minikube запускає віртуальну машину/контейнери — потрібна апаратна віртуалізація.

1. Увійдіть у **BIOS/UEFI** (при завантаженні: Del / F2 / F10 / F12 залежно від плати).
2. Знайдіть розділ **CPU / Advanced**:
   - `Intel Virtualization Technology (VT-x)` → **Enabled**
   - або `AMD SVM Mode` → **Enabled**
3. Збережіть (F10) та перезавантажтеся.

> Якщо комп'ютер сам є **віртуальною машиною** (VMware/VirtualBox/Hyper-V):
> увімкніть **Nested Virtualization** у налаштуваннях хоста.

**Перевірка (PowerShell):**

```powershell
(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled   # має бути True
systeminfo | Select-String "Hyper-V"                               # вимоги виконано
```

---

## 2. WSL2 (потрібен Docker Desktop)

Запустіть PowerShell **від імені адміністратора**:

```powershell
wsl --install
# Перезавантажте систему
wsl --set-default-version 2
wsl --list --verbose   # перевірка: VERSION = 2
```

---

## 3. Docker Desktop

1. Завантажте з <https://www.docker.com/products/docker-desktop/>.
2. Встановіть (за потреби перезавантажтеся).
3. Docker Desktop → **Settings → General**: увімкніть **"Use the WSL 2 based engine"**.
4. **Settings → Resources → WSL Integration**: увімкніть інтеграцію з дистрибутивом.
5. Перевірте:

```powershell
docker --version
docker run --rm hello-world
```

---

## 4. Minikube + kubectl

```powershell
winget install minikube
winget install Kubernetes.kubectl
# або вручну: https://minikube.sigs.k8s.io/docs/start/
```

Запуск кластера (драйвер docker). ⚠️ Останні версії Minikube (1.39+) всередині
kicbase запускають **containerd** (а не docker daemon), тому вкажіть
`--container-runtime=containerd` явно — інакше кластер може стартувати з помилкою
`cri-docker.socket: Socket service cri-docker.service not loaded`:

```powershell
minikube start --driver=docker --container-runtime=containerd
minikube addons enable ingress
kubectl get nodes
```

> ⚠️ `minikube docker-env` з драйвером docker у Windows **не працює**
> (помилка про SSH agent). Тому образи збираються в локальний Docker Desktop
> і завантажуються в кластер через `minikube image load` (див. розділ 5).

---

## 5. Локальний деплой платформи

`deploy.ps1` виконує ланцюжок **build у Docker Desktop → `minikube image load` →
`kubectl apply` → `kubectl rollout status`** (це робочий підхід для Minikube
1.39+ з containerd, де `minikube docker-env` не працює):

```powershell
.\scripts\minikube-start.ps1   # старт кластера (containerd + ingress)
.\scripts\deploy.ps1           # збірка образів + image load + apply
kubectl get pods -n devsecops -o wide   # усі 5 подів мають бути Running
```

Відкрити застосунки:

```powershell
kubectl port-forward -n devsecops svc/dota 8501:8501   # Dota 2 Analytics (головний сервіс)
minikube service frontend -n devsecops                # React-дашборд
# або через gateway (API):
minikube service gateway -n devsecops
```

Якщо ingress увімкнено, можна відкрити `http://dashboard.local` та `http://dota.local`
(для цього додайте у `C:\Windows\System32\drivers\etc\hosts` рядок
`192.168.49.2  dashboard.local  dota.local` — IP можна дізнатися через `minikube ip`).

> Маніфести в `k8s/` посилаються на локальний тег `devsecops-platform-*:local`
> з `imagePullPolicy: IfNotPresent`. CD (GitHub Actions) поверх них встановлює
> immutable digest образу `ghcr.io/...@sha256:...`, отриманий із перевіреного
> CI-артефакту, створює в кластері pull-secret `ghcr-pull` із довготривалим
> токеном із GitHub Secrets і додає його до pod-ів. Якщо rollout будь-якого
> сервісу не вдалося, скрипт повертає попередні образи та завершує CD з помилкою.

### Міграція даних

Data-сервіс автоматично виконує транзакційну міграцію старих SQLite-таблиць
`records` у `projects` під час першого запуску. Записи `new`, `in_progress`,
`done` та `archived` переносяться без втрати полів; міграція ідемпотентна,
тому повторний запуск не створює дублікати. Не видаляйте старий файл
`records.db` до резервної копії. У Kubernetes дані data та Dota сервісів
змонтовані на PVC `data-volume` і `dota-data`, тому перезапуск pod не стирає
проєкти, задачі чи історію прогнозів; не видаляйте ці claims під час планових
збережень. Якщо стара таблиця містила пріоритет поза діапазоном 1–5, міграція
нормалізує його до межі, щоб не втратити весь запис. Невідомий статус legacy
зупиняє міграцію з помилкою замість тихого перетворення на `planned`.

#### Обов'язковий перехід зі старого `emptyDir` на PVC

`kubectl apply` не копіює файл з `emptyDir` у новий PVC. Старі pod-и вже
можуть містити живі `records.db` або `dota_analytics.db`, тому CD і
`deploy.ps1` спочатку перевіряють специфікацію та **відмовляються** перемикати
`data`/`dota`, поки вона містить `emptyDir` (`scripts/k8s-preflight.sh`).
Не обходьте цю перевірку.

Для вже існуючого кластера виконайте міграцію один раз у maintenance-вікні
(після резервної копії кластера та зупинки зовнішнього запису):

1. Зробіть резервну копію БД **поки pod живий**, через SQLite online backup,
   а не копіювання лише `records.db` (WAL має бути включений у backup).
   Для data можна виконати в pod-і:

   ```powershell
   $dataPod = kubectl -n devsecops get pod -l app=data -o jsonpath='{.items[0].metadata.name}'
   kubectl -n devsecops exec $dataPod -- node -e "const D=require('better-sqlite3'); const db=new D('/data/records.db'); db.backup('/tmp/records.db.backup').then(()=>db.close())"
   kubectl -n devsecops cp "${dataPod}:/tmp/records.db.backup" "$env:TEMP\records.db.backup"
   ```

   Для Dota використайте Python- backup у `/app/data/dota_analytics.db` і
   збережіть його окремо. Перевірте, що backup відкривається та має
   `PRAGMA integrity_check = ok`; у data-файлі мають бути присутні WAL-дані
   з точки консистентності.

2. Після перевіреної копії зупиніть старі deployment-и
   (`kubectl -n devsecops scale deployment/data --replicas=0` та
   `kubectl -n devsecops scale deployment/dota --replicas=0`). Не видаляйте
   старі pod-и/claims до завершення перевірки.

3. Створіть `data-volume` і `dota-data` (лише PVC, не застосовуйте deployment
   з `k8s/*.yaml` ще раз), відновіть backup у тимчасовому pod-і з
   `python:3.12-slim`, перевірте `PRAGMA integrity_check`, кількість рядків у
   `records`/`users`/`prediction_history` і SHA-256 backup-файлу. Тільки після
   цього застосуйте повний `k8s/` або запустіть `deploy.ps1`/CD.

4. Перевірте, що нові pod-и бачать ті самі рядки, і збережіть backup до
   завершення smoke-тестів. Видалення PVC або повторне застосування старих
   `emptyDir`-маніфестів не є способом відкату.

Для нового кластера PVC спочатку порожні, тому окремий backup не потрібен;
preflight пропускає відсутні deployment-и. Автоматична міграція `records`
відбувається вже з відновленого файлу на першому запуску data-сервісу.

---

## 6. GitHub: репозиторій + Actions + Dependabot

1. Репозиторій: <https://github.com/Bimbow476/devsecops-platform> (гілка `main`).

2. Код завантажено; CI запускається автоматично на `push`/`pull_request`.

3. Після успішного CI на `main` автоматично запускається `cd.yml` (деплой).
   Для ручного повторного деплою доступний `workflow_dispatch` із гілки `main`; CD чекає на self-hosted runner.

4. **Dependabot**:
   - Відкрийте **Settings → Code security and analysis → Security updates**.
     Увімкніть **Dependabot security updates** та **Dependabot version updates**.
   - **Settings → Advanced Security → Dependabot security alerts** має бути ввімкнено
     (якщо функція доступна для вашого плану).
   - **Settings → Dependabot → Access** за потреби надайте Dependabot доступ
     до Actions та PR-коментарів.
   - Версійні оновлення налаштовуються файлом `.github/dependabot.yml`
     (`npm`, `pip`, `docker`, `github-actions`), з понеділковим розкладом і групуванням
     patch/minor-оновлень.
   - Перевірте **Security → Dependabot alerts**. Автоматичні PR-виправлення проходять
     CI, але не використовують GHCR-логін: push до registry дозволений лише для `main`.
     CodeQL на fork/Dependabot PR пропускає upload SARIF, для якого GitHub не видає
     write-токен; build + Trivy все одно виконуються.

---

## 7. Реєстрація self-hosted runner (для CD у Minikube)

GitHub-hosted runners **не мають доступу** до вашого локального кластера,
тому `cd.yml` виконується на вашій машині. `runs-on` вимагає мітки:

```yaml
runs-on: [self-hosted, linux, x64, minikube]
```

Оскільки мінікуб живе на Windows-хості, реєструємо Windows-runner із
**додатковими мітками** `linux` та `minikube` (без зміни `runs-on`):

1. GitHub → репозиторій → **Settings → Actions → Runners → New self-hosted runner**.
2. Завантажте archive **actions-runner-win-x64** з
   <https://github.com/actions/runner/releases/latest> та розпакуйте у `C:\actions-runner`.
3. Отримайте registration token та налаштуйте:

   ```powershell
   cd C:\actions-runner
   $token = (gh api -X POST repos/Bimbow476/devsecops-platform/actions/runners/registration-token | ConvertFrom-Json).token
   .\config.cmd --url https://github.com/Bimbow476/devsecops-platform --token $token `
     --name win-minikube --labels minikube,linux --unattended --replace
   ```

4. Запустіть runner. **Важливо**: скрипт-крок у `cd.yml` має `shell: bash`,
   тому у PATH процесу runner'а має бути **Git Bash** (не WSL `bash.exe`):

   ```powershell
   $env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH   # Git Bash попереду system32
   .\run.cmd
   ```

5. У процесі runner'а мають бути доступні `kubectl` (контекст `minikube`), `curl` та `tr`.
6. `.gitattributes` у репозиторії гарантує LF для `*.sh`, тому скрипти
   виконуються коректно навіть після Windows-checkout (без CRLF у шебанг).

> Через вимогу нижнього регістру в GHCR (`Bimbow476` → `bimbow476`) імена образів
> у CI ловеряться через bash `${REPO,,}` / `tr` — у білдах це вже враховано.

---

## 8. Публікація образів у GHCR (з CI)

`ci.yml` збирає й сканує всі образи на `push` і `pull_request`. Публікація в
`ghcr.io/<USER>/devsecops-platform-*` під токеном `GITHUB_TOKEN` виконується
окремим job лише після успішного CI для `main` (або ручного запуску з `main`).
Dependabot PR не мають доступу до `packages: write` і не намагаються пушити образи.

Після CI CD-воркфлоу створює в Minikube секрет `ghcr-pull` з
`GHCR_PULL_USERNAME` та `GHCR_PULL_TOKEN` і додає його до всіх deployment-ів.
Це має бути довготривалий read-токен для registry (наприклад, GitHub PAT із
`read:packages`), а не `GITHUB_TOKEN`: токен GitHub Actions застаріває, і
наступний kubelet pull приватного образу тоді впаде. Додайте ці два значення
у **Settings → Secrets and variables → Actions**; вони не зберігаються в
репозиторії та не друкуються у логах. Для ручного CD workflow також має
дозвіл `packages: read`, який уже визначено у `cd.yml`.

Образи (усі 5 сервісів): `devsecops-platform-{gateway,metrics,data,frontend,dota}`.
На PR/build-scanning використовується локальний тег `sha-<commit>`, який не
потрапляє в GHCR.

---

## ⚠️ Часті проблеми

| Проблема | Рішення |
|---|---|
| `minikube start` не стартує | Віртуалізація вимкнена в BIOS/не ввімкнено nested virtualization (п.1) |
| `docker: command not found` | Docker Desktop не встановлено або не стартувало (п.3) |
| `wsl` помилка | `wsl --install` + перезавантаження (п.2) |
| Поди `ImagePullBackOff` | Для локального режиму зберіть образи через `scripts/deploy.ps1`; для CD перевірте секрет `ghcr-pull` і `packages: read` у workflow |
| `cd.yml` не запускається | Немає self-hosted runner з відповідними мітками (п.7) |
| Dependabot не створює PR | Перевірте `.github/dependabot.yml` та що репо не в жодному блокуванні |
| `npm install` блокує скрипти (`allowScripts`) | Новіші npm блокують postinstall за замовчуванням. Для нативних модулів (better-sqlite3): `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3` |
| Dota-под у CrashLoopBackOff | Перевірте `kubectl logs -n devsecops deploy/dota`: Streamlit пише у `$HOME/.streamlit`; у Докерфайлі `HOME=/home/appuser` вже задано |
| Поди порт-forward відвалилися | Після CD-деплою под перестворюється — перезапустіть `kubectl port-forward` |