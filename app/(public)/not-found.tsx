import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="hero">Not found</h1>
      <p>That page does not exist, or it is not public.</p>
      <p>
        <Link href="/">Back to the home page</Link>
      </p>
    </>
  );
}
