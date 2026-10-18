import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Better Auth core tables (user, session, account, verification).
// Names and shapes follow Better Auth's schema so its Drizzle adapter works unchanged.

const stamp = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: stamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: stamp("access_token_expires_at"),
  refreshTokenExpiresAt: stamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: stamp("expires_at").notNull(),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
});
