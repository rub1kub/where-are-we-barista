# Внешние NMEA-примеры

## `vanavara-success-radio-altimeter.nmea`

Успешный контрольный NMEA-журнал для проверки режима `Журнал NMEA` без передачи `truthPath` в solver.

Запуск из CLI:

```bash
npm run nmea:analyze -- examples/vanavara-success-radio-altimeter.nmea
```

Ожидаемый результат:

- `truth: unavailable`;
- статус `FIX VALID` или, при изменении порогов, не хуже `FIX DEGRADED`;
- координаты `local_x_m` / `local_y_m` и WGS-84;
- путевая скорость около `44 м/с`;
- азимут около `73°`;
- валидные контрольные суммы NMEA.

Происхождение:

- это `synthetic control log`, не данные заказчика;
- журнал сгенерирован по текущему DEM-сэмплу района Ванавары;
- `BARO MSL` принят равным 1500 м;
- поле высоты в GGA используется как вход `RA AGL` по формату кейса;
- truth используется только для генерации файла и метаданных, но не передаётся в `solveFromNmea`.

Метаданные лежат рядом:

```text
examples/vanavara-success-radio-altimeter.meta.json
```

## `px4-derived-radio-altimeter.nmea`

NMEA-файл для проверки режима `Журнал NMEA` без стендовой кнопки.

Запуск из CLI:

```bash
npm run nmea:analyze -- examples/px4-derived-radio-altimeter.nmea
```

Происхождение:

- исходный локальный файл: `data/import/px4-fixed-wing-real-flight.csv`;
- источник строк: PX4 `vehicle_gps_position` CSV;
- преобразование: `scripts/generate-px4-nmea-demo.mjs`;
- поле высоты в GGA используется как вход `RA AGL` по формату кейса;
- `BARO MSL` принят равным 1500 м, поэтому `RA AGL = 1500 - высота_MSL_м`.

Ограничение: это не журнал заказного радиовысотомера. Это внешний PX4-журнал, приведённый к NMEA-формату для демонстрации импортного контура, парсинга и честных статусов качества.

В текущем DEM-сэмпле этот пример может давать `NO FIX`. Это ожидаемое поведение: профиль не соответствует карте Ванавары, поэтому система должна честно отказаться от координаты, а не выдавать уверенный ложный результат.
