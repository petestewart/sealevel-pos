import { redirect } from "next/navigation";

/** Bare /items has no inbox of its own; land on the pending inbox. */
export default function ItemsIndexPage() {
  redirect("/items/pending");
}
