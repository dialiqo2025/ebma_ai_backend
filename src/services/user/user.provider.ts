import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {  Users } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { createUserType, updateUserType } from "./user.validate";
import { hashPassword, sanitizeUser } from "../auth/auth.helper";
import { sendUserCreatedEmail, sendUserPasswordUpdatedEmail } from "./user.helper";

export const createUser = async (payload: createUserType) => {
  try {
    const { fullName, email, role, password, isActive } = payload;

    const existingUser = await db
      .select()
      .from(Users)
      .where(eq(Users.email, email))
      .limit(1);

    if (existingUser.length > 0) {
      return GenResObj(Code.CONFLICT, false, "Email already exists");
    };

    const hashedPassword = await hashPassword(password);

    const [newUser] = await db
      .insert(Users)
      .values({
        fullName,
        email,
        role,
      password: hashedPassword,
      user_enabled: isActive,
      email_verified: true,
    })
    .returning();

    if (!newUser) throw new Error("User creation failed");
    const safeUser = sanitizeUser(newUser);

    await sendUserCreatedEmail({
      to: email,
      name: fullName,
      email,
      password,
      role,
      tenantName: "N/A",
    });

    return GenResObj(Code.CREATED, true, "User created successfully", safeUser);
  } catch (error) {
    console.log("Getting error for createUser :", error);
    throw error;
  }
};

export const listUsers = async (
  page: number,
  page_size: number,
  exclude_user_uuid?: string,
  search?: string,
  role?: string,
  isActive?: boolean,
  includeTenants?: boolean
) => {
  try {
    const offset = (page - 1) * page_size;

    const whereClause = and(
      ne(Users.role, "superAdmin" as any),
      exclude_user_uuid ? ne(Users.user_uuid, exclude_user_uuid) : undefined,
      search
        ? or(
          ilike(Users.fullName, `%${search}%`),
          ilike(Users.email, `%${search}%`)
        )
        : undefined,
      role ? eq(Users.role, role as any) : includeTenants ? undefined : ne(Users.role, "tenant"),
      typeof isActive === "boolean" ? eq(Users.user_enabled, isActive) : undefined
    );

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(Users)
      .where(whereClause);

    const users = await db
      .select()
      .from(Users)
      .where(whereClause)
      .orderBy(desc(Users.created_at))
      .limit(page_size)
      .offset(offset);

    const safeUsers = users.map(sanitizeUser);
    const total_users_count = Number(countResult?.count ?? 0);
    const total_page_count = Math.ceil(total_users_count / page_size);
    const has_next_page = page < total_page_count;

    return GenResObj(Code.OK, true, "Users fetched successfully", {
      data: safeUsers,
      total_users_count,
      total_page_count,
      current_page: page,
      has_next_page,
    });
  } catch (error) {
    console.log("Getting error for listUsers :", error);
    throw error;
  }
};

export const getUserById = async (user_uuid: string) => {
  try {
    const user = await db
      .select()
      .from(Users)
      .where(eq(Users.user_uuid, user_uuid))
      .limit(1);

    if (user.length === 0) {
      return GenResObj(Code.NOT_FOUND, false, "User not found");
    }

    return GenResObj(Code.OK, true, "User fetched successfully", sanitizeUser(user[0]!));
  } catch (error) {
    console.log("Getting error for getUserById :", error);
    throw error;
  }
};

export const updateUser = async (user_uuid: string, payload: updateUserType) => {
  try {
    const existingUser = await db
      .select()
      .from(Users)
      .where(eq(Users.user_uuid, user_uuid))
      .limit(1);

    if (existingUser.length === 0) {
      return GenResObj(Code.NOT_FOUND, false, "User not found");
    }

    const updateData: any = {};

    if (payload.fullName !== undefined) updateData.fullName = payload.fullName;
    if (payload.email !== undefined) updateData.email = payload.email;
    if (payload.isActive !== undefined) updateData.user_enabled = payload.isActive;
    let plainPassword: string | undefined;
    if (payload.password !== undefined) {
      plainPassword = payload.password;
      updateData.password = await hashPassword(payload.password);
    }

    if (payload.role !== undefined) {
      updateData.role = payload.role;
    };

    if (Object.keys(updateData).length === 0) {
      return GenResObj(Code.BAD_REQUEST, false, "No fields to update");
    }

    const [updatedUser] : any = await db
      .update(Users)
      .set({
        ...updateData,
        updated_at: new Date(),
      })
      .where(eq(Users.user_uuid, user_uuid))
      .returning();

    if (!updatedUser) throw new Error("User update failed");
    const safeUser = sanitizeUser(updatedUser);

    if (plainPassword) {
      await sendUserPasswordUpdatedEmail({
        to: updatedUser.email,
        name: updatedUser.fullName || "User",
        email: updatedUser.email,
        password: plainPassword,
        role: updatedUser.role || "user",
        tenantName: "N/A",
      });
    }

    return GenResObj(Code.OK, true, "User updated successfully", safeUser);
  } catch (error) {
    console.log("Getting error for updateUser :", error);
    throw error;
  }
};

export const deleteUser = async (user_uuid: string) => {
  try {
    const existingUser = await db
      .select()
      .from(Users)
      .where(eq(Users.user_uuid, user_uuid))
      .limit(1);

    if (existingUser.length === 0) {
      return GenResObj(Code.NOT_FOUND, false, "User not found");
    }

    console.log("Getting the new schema log :", existingUser)

    const [deletedUser] = await db
      .delete(Users)
      .where(eq(Users.user_uuid, user_uuid))
      .returning();

    if (!deletedUser) throw new Error("User deletion failed");
    const safeUser = sanitizeUser(deletedUser);

    return GenResObj(Code.OK, true, "User deleted successfully", safeUser);
  } catch (error) {
    console.log("Getting error for deleteUser :", error);
    throw error;
  }
};

export const userSummary = async () => {
  try {
    const [totalUsersRow] = await db
      .select({ total_users: sql<number>`count(*)` })
      .from(Users)
      .where(and(ne(Users.role, "superAdmin" as any), ne(Users.role, "tenant" as any)));

    const [totalActiveUsersRow] = await db
      .select({ total_active_users: sql<number>`count(*)` })
      .from(Users)
      .where(and(ne(Users.role, "superAdmin" as any), ne(Users.role, "tenant" as any), eq(Users.user_enabled, true)));

    const [totalSuperAdminRow] = await db
      .select({ total_superAdmin: sql<number>`count(*)` })
      .from(Users)
      .where(eq(Users.role, "admin" as any));

    const [totalSuperAnalystRow] = await db
      .select({ total_superAnalyst: sql<number>`count(*)` })
      .from(Users)
      .where(eq(Users.role, "superAnalyst" as any));

    const [totalComplianceRow] = await db
      .select({ total_compliance: sql<number>`count(*)` })
      .from(Users)
      .where(eq(Users.role, "compliance" as any));

    const total_users = Number(totalUsersRow?.total_users ?? 0);
    const total_active_users = Number(totalActiveUsersRow?.total_active_users ?? 0);
    const total_superAdmin = Number(totalSuperAdminRow?.total_superAdmin ?? 0);
    const total_superAnalyst = Number(totalSuperAnalystRow?.total_superAnalyst ?? 0);
    const total_compliance = Number(totalComplianceRow?.total_compliance ?? 0);

    return GenResObj(Code.OK, true, "User summary fetched successfully", {
      total_users,
      total_active_users,
      total_superAdmin,
      total_superAnalyst,
      total_compliance,
    });
  } catch (error) {
    console.log("Getting error for userSummary :", error);
    throw error;
  }
};
