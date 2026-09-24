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
cd devsecops-platform
.\scripts\minikube-start.ps1   # старт кластера (containerd + ingress)
.\scripts\deploy.ps1           # збірка образів + image load + apply
kubectl get pods -n devsecops -o wide   # усі 4 поди мають бути Running
```

Відкрити дашборд:

```powershell
minikube service frontend -n devsecops
# або через gateway (API):
minikube service gateway -n devsecops
```

Якщо ingress увімкнено, можна відкрити `http://dashboard.local`
(для цього додайте у `C:\Windows\System32\drivers\etc\hosts` рядок
`192.168.49.2  dashboard.local` — IP можна дізнатися через `minikube ip`).

> Маніфести в `k8s/` посилаються на локальний тег `devsecops-platform-*:local`
> з `imagePullPolicy: IfNotPresent`. CD (GitHub Actions) поверх них ставить
> образи `ghcr.io/...:sha-<sha>` через `kubectl set image`.

---

## 6. GitHub: репозиторій + Actions + Dependabot

1. Створіть порожній репозиторій: <https://github.com/new> → name: `devsecops-platform`.

2. Завантажте код:

   ```bash
   cd devsecops-platform
   git init
   git add .
   git commit -m "init: devsecops platform"
   git branch -M main
   git remote add origin https://github.com/<USER>/devsecops-platform.git
   git push -u origin main
   ```

3. **CI** запуститься автоматично. `cd.yml` (деплой) чекатиме на self-hosted runner.

4. **Dependabot**:
   - *Security alerts* увімкнено за замовчуванням (GitHub → **Settings → Code security**).
   - *Version updates* конфігуруються файлом `.github/dependabot.yml` (вже є).
   - Результат: вкладка **Security → Dependabot alerts** + автоматичні PR-виправлення.

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
   $token = (gh api -X POST repos/<USER>/devsecops-platform/actions/runners/registration-token | ConvertFrom-Json).token
   .\config.cmd --url https://github.com/<USER>/devsecops-platform --token $token `
     --name win-minikube --labels minikube,linux --unattended --replace
   ```

4. Запустіть runner. **Важливо**: скрипт-крок у `cd.yml` має `shell: bash`,
   тому у PATH процесу runner'а має бути **Git Bash** (не WSL `bash.exe`):

   ```powershell
   $env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH   # Git Bash попереду system32
   .\run.cmd
   ```

5. У процесі runner'а мають бути доступні `kubectl` (контекст `minikube`) та `tr`.
6. `.gitattributes` у репозиторії гарантує LF для `*.sh`, тому скрипти
   виконуються коректно навіть після Windows-checkout (без CRLF у шебанг).

> Через вимогу нижнього регістру в GHCR (`Bimbow476` → `bimbow476`) імена образів
> у CI ловеряться через bash `${REPO,,}` / `tr` — у білдах це вже враховано.

---

## 8. Публікація образів у GHCR (з CI)

`ci.yml` пушить образи в `ghcr.io/<USER>/devsecops-platform-*` під токеном `GITHUB_TOKEN`
(видається автоматично). Після першого запуску CI перейдіть у
**repo → Packages** і зробіть пакунки публічними, якщо репозиторій приватний і ви
хочете тягнути образи на self-hosted runner без додаткової авторизації.

---

## ⚠️ Часті проблеми

| Проблема | Рішення |
|---|---|
| `minikube start` не стартує | Віртуалізація вимкнена в BIOS/не ввімкнено nested virtualization (п.1) |
| `docker: command not found` | Docker Desktop не встановлено або не стартувало (п.3) |
| `wsl` помилка | `wsl --install` + перезавантаження (п.2) |
| Поди `ImagePullBackOff` | Локальні образи `:local` збираються лише через `scripts/deploy.ps1`; `imagePullPolicy: IfNotPresent` |
| `cd.yml` не запускається | Немає self-hosted runner з відповідними мітками (п.7) |
| Dependabot не створює PR | Перевірте `.github/dependabot.yml` та що репо не в жодному блокуванні |
| `npm install` блокує скрипти (`allowScripts`) | Новіші npm блокують postinstall за замовчуванням. Для нативних модулів (better-sqlite3): `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3` |