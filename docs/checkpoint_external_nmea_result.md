# Чекпоинт: внешний NMEA-журнал PX4

Цель проверки: показать, что режим `Журнал NMEA` принимает файл извне и запускает solver без `truthPath`, `trueSpeed`, `trueAzimuth` и сгенерированной истинной траектории.

## Вход

```text
examples/px4-derived-radio-altimeter.nmea
```

Параметры:

- строк NMEA: 1690;
- формат: `$GPGGA`;
- `BARO MSL`: 1500 м;
- поле высоты GGA используется как `RA AGL` по формату кейса;
- источник исходных данных: локальный PX4 `vehicle_gps_position` CSV, преобразованный скриптом `npm run nmea:generate-demo`.

## Результат UI

| Поле | Значение |
| --- | --- |
| Навигационный статус | `NO FIX` |
| Причина | корреляционный пик не прошёл минимальные пороги качества |
| corr best | 0.901 |
| corr second | 0.901 |
| ambiguity margin | 0.000 |
| profile RMSE | 260 м |
| compute time | 834 мс |
| confidence | 39% |
| terrain sigma | 16.9 м |
| truth | unavailable |
| ground_speed_mps | 41.0 |
| azimuth_deg | 342 |
| uncertainty_m | н/д |
| course_correction_deg | not configured |

## Интерпретация

Это не заказной журнал радиовысотомера и не подогнанный стендовый `truthPath`. Поэтому корректное поведение системы здесь не `FIX VALID`, а честный отказ `NO FIX`: внешний файл разобран, профиль построен, поиск выполнен, но совпадение с текущей ЦМР неоднозначно и недостаточно качественно.

Скриншот:

![External NMEA PX4 demo](assets/external-nmea-px4-demo.png)
