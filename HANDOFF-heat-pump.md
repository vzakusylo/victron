# Handoff — тепловой насос в Node-RED на Cerbo GX

Дата: 2026-11-07 · Автор: Vadym Zakusylo + Claude · Репо: https://github.com/vzakusylo/victron

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
- В ASUS включён Manual Assignment, закреплены 13 адресов (.9 .26 .31 .53 .57 .94 .124 .139 .148 .149 .196 .201 .244). Какие из них насос/реле/розетка — ещё не определено (определит Tuya-нода).
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
