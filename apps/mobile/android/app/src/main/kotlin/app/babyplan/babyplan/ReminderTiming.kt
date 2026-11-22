package app.babyplan.babyplan

import java.time.LocalTime
import java.time.ZonedDateTime

// 家庭业务日期固定在家庭时区。系统晚送旧闹钟时，不能补发昨天或 20 点后的提醒。
internal object ReminderTiming {
    val cutoff: LocalTime = LocalTime.of(20, 0)

    fun next(now: ZonedDateTime, time: LocalTime, handled: String?, lastDelivered: String?): ZonedDateTime {
        val today = now.toLocalDate()
        val due = today.atTime(time).atZone(now.zone)
        val day = today.toString()
        return if (due.isAfter(now) && day != handled && (lastDelivered == null || day > lastDelivered)) {
            due
        } else {
            today.plusDays(1).atTime(time).atZone(now.zone)
        }
    }

    fun canNotify(now: ZonedDateTime, due: ZonedDateTime, handled: String?, lastDelivered: String?): Boolean {
        val day = now.toLocalDate().toString()
        return !now.isBefore(due) && now.toLocalDate() == due.toLocalDate() && now.toLocalTime().isBefore(cutoff) &&
            day != handled && (lastDelivered == null || day > lastDelivered)
    }
}
