export function homePayload(role = "admin", { rich = false } = {}) {
  const payload = {
    generated_at: "2026-10-10T17:45:00Z",
    studio: { id: "studio-a", name: "Test studio", timezone: "UTC", today: "2026-10-10" },
    viewer: { role, first_name: "Test" },
    needs_attention: { items: [] },
    classes_today: { total: 0, overflow: 0, rows: [] },
    stats: {
      active_students: { total: 15, active: 10, trialing: 2, on_hold: 3 },
      attendance: { window_days: 30, sessions: 5, seats_filled: 7, capacity: 74 },
    },
    recent_students: [
      { id: "new-1", name: "New Student", status: "trialing", started_on: "2026-10-03" },
    ],
  };
  if (role !== "instructor") {
    payload.stats.follow_ups = {
      due_count: rich ? 2 : 0,
      overdue_count: rich ? 1 : 0,
      due_today_count: rich ? 1 : 0,
      oldest_due_date: rich ? "2026-10-08" : null,
    };
    payload.follow_ups = {
      rows: rich
        ? [
            {
              id: "lead-1",
              first_name: "Ari",
              last_name: "Lead",
              stage: "inquiry",
              follow_up_date: "2026-10-08",
            },
            {
              id: "lead-2",
              first_name: "Bo",
              last_name: "Lead",
              stage: "contacted",
              follow_up_date: "2026-10-10",
            },
          ]
        : [],
    };
  }
  if (role !== "front_desk") {
    payload.stats.promotions = { ready_count: rich ? 1 : 0, needs_approval: rich ? 1 : 0 };
    payload.ready_to_promote = {
      rows: rich
        ? [
            {
              student_id: "promote-1",
              name: "Kai Student",
              from: { name: "White", color: "#ffffff" },
              to: { name: "Yellow", color: "#ffff00" },
              classes_at_rank: 9,
              needs_approval: true,
            },
          ]
        : [],
    };
  }
  if (rich) {
    payload.needs_attention.items = [
      ...(role !== "instructor" ? [{ kind: "payments", count: 3 }] : []),
      ...(role === "admin" ? [{ kind: "setup", count: 1, next_step: "classes" }] : []),
      { kind: "away", count: 11 },
      ...(role !== "instructor" ? [{ kind: "contact", count: 1, student_id: "contact-1" }] : []),
    ];
    payload.classes_today = {
      total: 6,
      overflow: 2,
      rows: [
        {
          id: "ended",
          name: "Early basics",
          start_time: "09:00",
          end_time: "10:00",
          checked_in: 4,
          capacity: 12,
        },
        {
          id: "current",
          name: "Noon basics",
          start_time: "11:30",
          end_time: "13:00",
          checked_in: 0,
          capacity: 12,
        },
        {
          id: "next",
          name: "Evening basics",
          start_time: "16:00",
          end_time: "17:00",
          checked_in: 0,
          capacity: 12,
        },
        {
          id: "unknown-capacity",
          name: "Open practice",
          start_time: "18:00",
          end_time: "19:00",
          checked_in: 0,
          capacity: null,
        },
      ],
    };
  }
  return payload;
}
