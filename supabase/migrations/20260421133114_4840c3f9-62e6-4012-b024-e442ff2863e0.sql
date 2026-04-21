SELECT cron.unschedule(7);
SELECT cron.unschedule(8);
SELECT cron.unschedule(9);
SELECT cron.unschedule(10);
SELECT cron.alter_job(2, schedule := '*/15 * * * *');
SELECT cron.alter_job(6, schedule := '*/10 * * * *');
SELECT cron.alter_job(11, schedule := '0 */2 * * *');