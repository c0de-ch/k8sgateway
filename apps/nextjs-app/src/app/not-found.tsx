import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="lead">There is no page at this address.</p>
      <Link className="btn" href="/">
        Back to start
      </Link>
    </>
  );
}
