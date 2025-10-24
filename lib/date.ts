const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDateTimeLocal(date: Date | null): string {
  if (!date) {
    return "—";
  }
  const local = new Date(date);
  const month = MONTHS[local.getMonth()];
  const day = local.getDate();
  let hours = local.getHours();
  const minutes = local.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) {
    hours = 12;
  }
  return `${month} ${day}, ${hours}:${minutes} ${ampm}`;
}
