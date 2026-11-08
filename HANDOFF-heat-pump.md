# Handoff — тепловой насос в Node-RED на Cerbo GX

Дата: 2026-11-07, обновлено 2026-11-08 · Автор: Vadym Zakusylo + Claude · Репо: https://github.com/vzakusylo/victron

## Обновление 2026-11-08

Этот раздел главнее разделов ниже там, где они расходятся.

**Состояние**

| Что | Состояние |
|---|---|
| Cerbo GX | **d#122** = master `686ebca` (d#121, PR #9) + исправление реле Boiler; 213 узлов; задеплоено 08.11 19:16 |
| Heat Pump page | насос, реле Boiler, байпас — **CONNECTED**; счётчик SA1 — ID и ключ введены, но устройство **недоступно** с GX |
| Репо | `flows.json` d#122, README, `docs/` и картинки — PR #10 (ветка `claude/handoff-cloud-601be3`) |
| Бэкапы на GX | `/data/home/nodered/.node-red/backup-20261108-boiler/`, `backup-20261108-pre-d122/` |

**Что сделано**

1. **Реле Boiler**: работает на протоколе **3.5** и **не шлёт UDP-маяки**, поэтому нода без IP не находила его (`find() timed out`). MAC взят в Smart Life Web (eu.device.tuya.ai → Device List → Boiler → Detail), по нему в ARP GX найден IP **192.168.1.53**. В ноде заданы `deviceIp` и `tuyaVersion 3.5` (обычный конфиг, не credentials). Local Key в `.secrets` верный.
2. **Полный d#122 на GX**: GX сам скачал `flows.json` с GitHub (`686ebca`) и применил правку Boiler; хэш совпал с файлом в репо. Ни один узел не удалён, credentials сохранены. До этого на GX фактически был d#120, а не d#121.
3. **Счётчик SA1** (`bff533964da65dd78dlha6`): Local Key взят в Tuya API Explorer и добавлен в `.secrets/tuya-devices.json` и в credentials ноды на GX. Устройство подключено к Wi-Fi D-Link, где клиенты изолированы, — GX его не видит.
4. **ASUS DHCP**: Manual Assignment был **выключен, список пуст** (запись о 13 закреплённых адресах ниже была неверной). Включён, устройства закреплены на текущих IP (таблица ниже). Apply перезапускает Wi-Fi ASUS примерно на 30 с; Tuya-ноды переподключаются сами.
5. **MCP в Claude Code**: работает в новых сессиях — `NODE_EXTRA_CA_CERTS` задан в `~/.claude/settings.json` → `env`.
6. **Скриншоты и README**: все картинки дашборда в `docs/images/` пересняты на d#122 (меню с Heat Pump, все страницы; токен на странице MCP скрыт), добавлены `heat-pump-power.png` и `heat-pump-history.png`. README и `docs/heat-pump.md`: кривая для P23 = 37, Boiler 3.5 / нужен IP, таблица устройств с IP. Снимались через VRM-прокси в Chrome кадрами с прокруткой и склейкой.

**Устройства в сети ASUS (192.168.1.x), IP закреплены**

Telia-2FF703 и Telia-2FF703_RPT — одна сеть и один DHCP, разницы для адресов нет; через RPT только лишний беспроводной участок.

| IP | Устройство | Tuya ID | Протокол |
|---|---|---|---|
| .31 | Heating pump (насос) | `bf3f2552b6fcd2c689fzre` | 3.3 |
| .53 | Boiler (клапан ГВС, ON = бойлер) | `bf894708aa7e3ac196zjzk` | **3.5**, маяков нет |
| .139 | Off Heating exchange (байпас, ON = байпас) | `bf3ff3d877d898b531cuoq` | 3.4 |
| .148 | Voksen heating (флаг оттайки) | `bf2e8c592bd8d22486nwux` | 3.5 |
| .149 | Tuya, имя не определено | `bf6b05946f99e40b4egwpa` | 3.3 |
| .9 | Tuya-подобное (порт 6668), не Boiler | ? | ? |
| .94 | Cerbo GX `einstein`, eth0 | — | — |
| .26, .124, .196 | не определены | — | — |

**В сети D-Link (192.168.0.x)**: Kitchen `bf225be23dfc3630cbxwbb` .131 / 3.4, Stua hun `bf28bca26a4f355faaajvj` .196 / 3.3, **SA1 power meter** `bff533964da65dd78dlha6` — IP неизвестен (в аренде ASUS его нет).

**Открыто**

1. **SA1**: перевести на Wi-Fi «Telia-2FF703» в Smart Life, затем вписать IP и протокол в ноду (+1 к d#). При перепривязке Local Key сменится — взять заново.
2. Смёрджить PR #10 (`flows.json` d#122, README, `docs/` с 15 картинками, этот файл).
3. Большие передачи ПК ↔ GX почти стоят (590 КБ > 2 мин), мелкие ответы мгновенные — вероятная причина медленного MCP с ПК. Обход: GX скачивает файлы с GitHub сам.
4. Перевыпустить MCP-токен (он ещё и открытым текстом в `~/.claude.json`).
5. Проверить уставку после цикла бойлера (P23 = 37, ожидается ~37 °C при −2 °C).

## Цель

Перенести управление тепловым насосом (воздух-вода, Tuya) из облачных сценариев Tuya в Node-RED на Victron Cerbo GX. Сделать страницу «Heat Pump» в дашборде Node-RED вместо Home Assistant (HA ставить не хочу). Позже связать насос с контролем пиков kapasitetsledd (ESS peak shaving).

## Где сейчас

| Что | Состояние |
|---|---|
| Cerbo GX | вкладка **d#110** загружена; Node-RED 3.1.15; Tuya-палитры **нет** (установка была остановлена) |
| Репо master | `e68c8fe docs`, **d#111** |
| Ветка `heat-pump-page` | коммит `28acfc6` **d#112** — страница Heat Pump (только чтение). **Не запушен**: у Claude нет доступа к репо (403). Есть патч `0001-d-112-Heat-Pump-page-Tuya-local-read-only.patch` |
| Локальная копия | `C:\learn\victron` — без d#112 |

## Сеть (подробно — проект «Home», `claude/home-network.md`)

```
D-Link DIR-X1530 (192.168.0.x, главный)
 └─ ASUS RT-N12E «Telia-2FF703» (WAN 192.168.0.180, LAN 192.168.1.x, свой NAT, router.asus.com)
     └─ повторитель «Telia-2FF703_RPT»
         ├─ Cerbo GX 192.168.1.94 (кабелем, хост einstein, MAC C0:61:9A:B8:7D:3D)
         └─ Tuya: насос, реле Boiler, розетка байпаса
```

- Cerbo и Tuya в **одной подсети** — локальное управление возможно.
- ~~В ASUS включён Manual Assignment, закреплены 13 адресов~~ — на 08.11 оказалось неверно; актуальный список — в разделе «Обновление 2026-11-08».
- ПК в сети D-Link не видит 192.168.1.x — для работы с устройствами подключаться к Telia.

## Устройства Tuya

| Роль | Имя в Smart Life | Device ID | Заметки |
|---|---|---|---|
| Насос | Heating pump | `bf3f2552b6fcd2c689fzre` | product `5oc9wmac3bbidekc`, контроллер PW58280 (Powerworld/Michl PW040, SMP13) |
| Клапан ГВС | Boiler | `bf894708aa7e3ac196zjzk` | DP 1: ON = бойлер, OFF = отопление |
| Байпас теплообменника | Off Heating exchange | `bf3ff3d877d898b531cuoq` | DP 1: ON = байпас |
| (флаг) | Voksen heating | `bf2e8c592bd8d22486nwux` | DP «Defrost» используется облачными правилами как флаг оттайки; в Node-RED станет переменной |

**Local Key в репо не хранить.** Брать: platform.tuya.com → проект **«Home local»** (Central Europe, создан 2026-11-07, Smart Life аккаунт привязан) → API Explorer → Device Management → *Query Device Details in Bulk* → поле `local_key`. Ключ меняется при перепривязке устройства. Протокол неизвестен — пробовать 3.3, затем 3.4/3.5.

## Карта DP насоса (из cloud thing model)

Чтение: 101 обратка, **102 подача**, **103 улица**, 104 нагнетание, 105 всас, 106 наружный змеевик, **108 бак**, 109/111 ЭРВ, 112 ток компрессора, 113 радиатор, 114 DC шина, **115 частота компрессора**, **116** / 117 вентиляторы, **15 ошибки** (bitmap Er03…Er70).
Запись: 1 вкл, **2 режим** smart/strong/mute (= Smart/Powerful/Silent), 5 work_mode (wth/heat/cool/wth_heat/wth_cool), 121/122 гистерезисы, **123 уставка ГВС** (28–60), 124 охлаждение, **125 уставка отопления** (15–55), 126 компенсация, **132/133/134 = P22/P23/P24** (кривая), 135–144 частоты, ТЭН, оттайка.
Кривая P22: уставка = 20 + 0,4 × (P23 − T улицы), 20…60 °C (сейчас P23 = 32, P24 = 4).

Полная таблица — `docs/heat-pump.md` в ветке.

## Текущая логика в облаке Tuya (переносим)

Каталог: проект claude.ai «Heating pump» → `claude/automation catalog`. Консоль: eu.device.tuya.ai.

- **Бойлер по улице:** >1 °C → 50 (старт бак <47, стоп >49); −4…1 → 46 (44/46); −10…−5 → 42 (41/42); ≤−11 → 40 (36/39).
- **Последовательность:** старт (P22 off, уставка = цель, байпас ON, клапан на отоплении) → когда подача > порог: флаг оттайки ON → уставка 20 → пауза 60 с → клапан на бойлер → уставка бака → байпас OFF → флаг снимается через 10 мин → стоп по баку: клапан на отопление, P22 on.
- **Оттайка:** признак = вентилятор 0 и компрессор > 30 Гц (улица < 14). При отоплении: байпас ON + флаг; возврат (DF exchange on 31) при вентиляторе > 300, подаче > 27, уставке < 45, P22 on → байпас OFF. При бойлере (DF switch to heating): клапан на отопление, байпас ON; DF safe снимает флаг через 10 мин.
- **Режимы:** Silent при улице > 0, без оттайки, уставка < 40, бойлер off; B46 mode — Silent при подаче > 48 во время бойлера. Не включать Silent в преднагреве (подача застревает ниже порога).
- **Известные беды облака:** правило срабатывает на каждый отчёт датчика (B50 on 45 раз за 20 мин); ложная оттайка при пуске компрессора; гонка флага (сегодня флаг перенесён первым действием); зависший байпас 17:52–20:30 05.11.

## Что сделано в d#112 (ветка `heat-pump-page`)

- `Poll heat pump (GET, read only)` — каждые 60 с `{"operation":"GET","schema":true}`. **Без `operation` нода шлёт SET!**
- 3 × `tuya-smart-device` (Store as credentials, ID/Key пустые) → `topic = hp|valve|bypass` → `Heat pump state` (`34 Heat pump state.js`)
- `Heat pump page` (`35 Heat pump page.html`) + график 24 ч (подача, обратка, бак, улица)
- `flow.heatPump` (сырые DP), `flow.heatPumpModel` (модель страницы)
- `Sync-34`, `Sync-35` (`Sync-Template`) в `sync-commands.ps1`; `docs/heat-pump.md`; README, development.md
- Функция проверена на тестовых сообщениях; висячих проводов в flows.json нет; ключей в репо нет

## Как задеплоить d#112

1. Применить патч в `C:\learn\victron` (`git am …patch`) или получить ветку после пуша.
2. Node-RED на Cerbo (через VRM → Venus OS Large → Node-RED) → Manage palette → установить `node-red-contrib-tuya-smart-device` (5.4.0). SSH не нужен.
3. Импортировать `flows.json` (d#112), в трёх Tuya-нодах ввести Device ID + Local Key, Deploy.
4. Дашборд → Heat Pump: проверить «connected» и данные. Подписать IP устройств в `home-network.md` и в ASUS.
5. Одновременно не держать другое локальное подключение к тем же устройствам (tinytuya, HA).

## Дальше (план)

1. **Этап 1** — сутки смотреть страницу, сверить с логом Tuya.
2. **Этап 2** — `36 Heat pump controller.js`: конечный автомат HEATING / DHW_PREHEAT / DHW_STOP_WAIT / DHW_HEAT / DEFROST_HEATING / DEFROST_DHW. Оттайка должна держаться 60–90 с и игнорироваться 3–5 мин после пуска; сторож байпаса ≤ 20 мин; безопасное состояние при молчании устройства > 5 мин (клапан на отопление, байпас off, P22 on); реакция только на фронты; повтор команды, если DP не подтвердился за 2 мин. Сначала dry-run.
3. **Переключение** — выключить в Tuya правила B…, DF…, HP silent, B46 mode, HP Er03 restart; включить отправку из Node-RED. Откат: выключить флоу, включить правила.
4. **Этап 3** — связь с контроллером сети: не греть ГВС у лимита часа, ГВС ночью 22–06; MCP-инструмент `get_heat_pump`.
5. Не разобрано: правило HP Er03 restart (10 действий); батарейные датчики спят — на них не опираться.

## Victron / Protection (наблюдения)

- Батарея 14S NMC, JBD **350 Ah**; ESS #6; MultiPlus-II 48/5000/70-50.
- Октябрь VRM: из сети 1420 кВт·ч, потребление 1395, PV 10,9; потери ~36 кВт·ч/мес.
- Protection: Grid CT Support включён (start 56,9 / release 56 / full 57 В, HV only, макс. 890 W, export guard on, min import 200 W); AC Force Charging (start 55,8 / release 55,9 / full 54 В, 1350 W). Вопрос «ставить max support 0 W или выключить» — **не решён**.
- Окупаемость считалась при ошибочной ёмкости 2,6 кВт·ч — пересчитать с 350 Ah.

## Безопасность — сделать

- `garag-venus-os/1.txt`, строка 1 — SSH host/port Cerbo в публичном репо: убрать (и из истории) или сменить порт.
- D-Link — проверить, что заводской пароль админки сменён.
- Дать Claude GitHub App доступ к `vzakusylo/victron`, если нужен пуш из сессий: https://github.com/apps/claude/installations/select_target

## Ссылки

- Проект claude.ai «Home»: `claude/victron-repo.md`, `claude/home-network.md`
- Проект claude.ai «Heating pump»: чат «Ошибка низкого потока при переключении на бойлер», `claude/automation catalog`, `tools/tuya read log`
- VRM: installation 903245 · Node-RED: VRM → Venus OS Large
- Tuya: platform.tuya.com (проект «Home local»), eu.device.tuya.ai (сценарии)
