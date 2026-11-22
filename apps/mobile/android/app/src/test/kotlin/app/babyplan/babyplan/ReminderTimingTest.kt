package app.babyplan.babyplan

import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReminderTimingTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private fun at(day: Int, hour: Int, minute: Int = 0) = ZonedDateTime.of(2026, 11, day, hour, minute, 0, 0, zone)

    @Test fun doesNotDeliverLateAlarmAfterQuietHoursOrOnAnotherDate() {
        val due = at(13, 19, 30)
        assertTrue(ReminderTiming.canNotify(at(13, 19, 50), due, null, null))
        assertFalse(ReminderTiming.canNotify(at(13, 20), due, null, null))
        assertFalse(ReminderTiming.canNotify(at(14, 0), due, null, null))
    }

    @Test fun doesNotRepeatAfterCompletionOrClockRollback() {
        val handled = "2026-11-13"
        val time = LocalTime.of(18, 0)
        assertEquals(at(14, 18), ReminderTiming.next(at(13, 17), time, handled, null))
        assertEquals(at(14, 18), ReminderTiming.next(at(13, 17), time, null, handled))
        assertFalse(ReminderTiming.canNotify(at(13, 18), at(13, 18), handled, null))
        assertFalse(ReminderTiming.canNotify(at(13, 18), at(13, 18), null, handled))
        assertTrue(ReminderTiming.canNotify(at(14, 18), at(14, 18), null, handled))
    }
}
