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

Запуск кластера (драйвер docker):

```powershell
minikube start --driver=docker
minikube addons enable ingress
kubectl get nodes
```

> Якщо `minikube start` падає — перш за все перевірте п.1 (віртуалізацію).

---

## 5. Локальний деплой платформи

```powershell
cd devsecops-platform
.\scripts\minikube-start.ps1   # старт кластера
.\scripts\deploy.ps1           # збірка образів + kubectl apply
minikube service frontend -n devsecops
```

Якщо ingress увімкнено, можна відкрити `http://dashboard.local`
(для цього додайте у `C:\Windows\System32\drivers\etc\hosts` рядок
`192.168.49.2  dashboard.local` — IP можна дізнатися через `minikube ip`).

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
тому `cd.yml` виконується на вашій машині.

1. GitHub → репозиторій → **Settings → Actions → Runners → New self-hosted runner**.
2. Оберіть ОС (Windows) та архітектуру, виконайте команди у корені проєкту:

   ```powershell
   # GitHub надасть конкретні команди з токеном; зразок:
   mkdir actions-runner; cd actions-runner
   # (завантажте runner archive за посиланням зі сторінки)
   .\config.cmd --url https://github.com/<USER>/devsecops-platform --token <TOKEN>
   .\run.cmd
   ```

3. Додайте мітку `minikube` (редагуйте `.github/workflows/cd.yml` за потреби).
4. У сесії runner'а мають бути доступні `kubectl` із контекстом Minikube.

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