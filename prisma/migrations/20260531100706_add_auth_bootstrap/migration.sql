-- CreateTable
CREATE TABLE "auth_bootstrap" (
    "id" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_bootstrap_pkey" PRIMARY KEY ("id")
);
