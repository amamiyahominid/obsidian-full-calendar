import { getEventsFromICS } from "./ics";

describe("ics tests", () => {
    it("parses all day event", () => {
        const ics = `BEGIN:VCALENDAR
PRODID:blah
X-WR-CALNAME:Test calendar
X-WR-TIMEZONE:Etc/UTC
VERSION:2.0
CALSCALE:GREGORIAN
X-PUBLISHED-TTL:PT5M
METHOD:PUBLISH
BEGIN:VEVENT
UID:7389432083-0-40713-74006
SEQUENCE:1
CLASS:PUBLIC
CREATED:20200101T000000Z
GEO:40.7128;-74.006
DTSTAMP:20230226T143136Z
DTSTART;VALUE=DATE:20230226
DESCRIPTION:Description!
LOCATION:New york city
URL:https://www.example.com
STATUS:CONFIRMED
SUMMARY:EVENT TITLE
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR`;
        const events = getEventsFromICS(ics);
        expect(events).toMatchSnapshot(ics);
    });

    it("parses gcal ics file", () => {
        const ics = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Obsidian Test Calendar
X-WR-TIMEZONE:America/New_York
BEGIN:VTIMEZONE
TZID:America/New_York
X-LIC-LOCATION:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;VALUE=DATE:20220302
DTEND;VALUE=DATE:20220303
DTSTAMP:20230302T233513Z
UID:5r09pnnlktaqivstai5vlbqb1h@google.com
CREATED:20220226T211158Z
DESCRIPTION:
LAST-MODIFIED:20220226T214634Z
LOCATION:
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:All day event
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20220301T110000
DTEND;TZID=America/New_York:20220301T123000
RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TH,TU
DTSTAMP:20230302T233513Z
UID:5tt2avr2th0h65homv3b6jeqof@google.com
CREATED:20220226T211144Z
DESCRIPTION:
LAST-MODIFIED:20220226T214627Z
LOCATION:
SEQUENCE:1
STATUS:CONFIRMED
SUMMARY:Recurring event
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART:20220228T164500Z
DTEND:20220228T194500Z
DTSTAMP:20230302T233513Z
UID:40mdbe6fvc1rmd60n6r0c3go7e@google.com
X-GOOGLE-CONFERENCE:https://meet.google.com/riu-josb-pdb
CREATED:20220226T210517Z
DESCRIPTION:This is an example <i>event.</i>\n\nJoin with Google Meet: http
    s://meet.google.com/riu-josb-pdb\nOr dial: (US) +1 609-726-6186 PIN: 156393
    865#\nMore phone numbers: https://tel.meet/riu-josb-pdb?pin=1416269198709&h
    s=7\n\nLearn more about Meet at: https://support.google.com/a/users/answer/
    9282720
LAST-MODIFIED:20220226T214608Z
LOCATION:
SEQUENCE:1
STATUS:CONFIRMED
SUMMARY:Hello\, iCal!
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART:20220219T190000Z
DTEND:20220219T230000Z
DTSTAMP:20230302T233513Z
UID:44hekcaaf0or7547vhqa772mqj@google.com
CREATED:20220220T002201Z
DESCRIPTION:
LAST-MODIFIED:20220220T002201Z
LOCATION:
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Work on GCal Sync
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20220216
DTEND;VALUE=DATE:20220217
DTSTAMP:20230302T233513Z
UID:7ooluqb717vabebvc9gkc38c9l@google.com
CREATED:20220220T002146Z
DESCRIPTION:
LAST-MODIFIED:20220220T002146Z
LOCATION:
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Announce Beta
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR
        `;
        const events = getEventsFromICS(ics);
        expect(events).toMatchSnapshot(ics);
    });

    // Regression test for a Google Calendar "this and following events" edit
    // on a JST calendar. Google splits the recurrence into two VEVENTs: the
    // original series capped with a UTC UNTIL (23:59:59 local expressed in Z)
    // and a brand-new series starting on the split day. The split day must not
    // leak backwards across the timezone boundary: the old series' last
    // occurrence is 7/2 and the new series starts exactly on 7/3.
    it("parses a JST this-and-following split without shifting the boundary", () => {
        const ics = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-TIMEZONE:Asia/Tokyo
BEGIN:VTIMEZONE
TZID:Asia/Tokyo
X-LIC-LOCATION:Asia/Tokyo
BEGIN:STANDARD
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:JST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20260526T060000
DTEND;TZID=Asia/Tokyo:20260526T073000
RRULE:FREQ=DAILY;UNTIL=20260702T145959Z
DTSTAMP:20260702T151319Z
UID:9u63e1nkse2ut78ggffh2db0ga@google.com
CREATED:20260525T211445Z
LAST-MODIFIED:20260702T150646Z
SEQUENCE:5
STATUS:CONFIRMED
SUMMARY:Old series
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20260703T070000
DTEND;TZID=Asia/Tokyo:20260703T083000
RRULE:FREQ=DAILY
DTSTAMP:20260702T151319Z
UID:s1gn1ttb1mr4dbv2sci44debig@google.com
CREATED:20260702T150646Z
LAST-MODIFIED:20260702T150646Z
SEQUENCE:6
STATUS:CONFIRMED
SUMMARY:New series
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`;

        const events = getEventsFromICS(ics);
        const oldSeries = events.find((e) => e.title === "Old series");
        const newSeries = events.find((e) => e.title === "New series");

        expect(oldSeries).toMatchObject({
            type: "rrule",
            startDate: "2026-05-26",
            startTime: "06:00",
            endTime: "07:30",
        });
        expect(newSeries).toMatchObject({
            type: "rrule",
            // The new series must begin on the split day itself, not the
            // previous local day.
            startDate: "2026-07-03",
            startTime: "07:00",
            endTime: "08:30",
        });
    });
});
