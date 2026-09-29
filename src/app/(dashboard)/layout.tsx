import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { Nav } from "@/components/nav";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdmin())) redirect("/login");

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      <Nav />
      <main className="flex-1 min-w-0">
        <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:px-10 lg:py-8 2xl:max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
