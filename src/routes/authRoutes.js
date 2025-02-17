const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const { db } = require("../config/firebase");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const { CLOUDINARY_UPLOAD_PRESET, CLOUDINARY_CLOUD_NAME, JWT_SECRET } =
  process.env;

const validateFields = (fields) => {
  for (const [key, value] of Object.entries(fields)) {
    if (!value)
      return `${key.charAt(0).toUpperCase() + key.slice(1)} is required`;
  }
  if (fields.password && fields.password.length < 8)
    return "Password must be at least 8 characters long";
  return null;
};

const uploadImageToCloudinary = async (fileBuffer, fileName) => {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error("File buffer is empty");
  }

  const formData = new FormData();
  formData.append("file", fileBuffer, fileName);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("api_key", process.env.CLOUDINARY_API_KEY);
  formData.append("timestamp", Math.floor(Date.now() / 1000));

  try {
    const response = await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      formData,
      { headers: formData.getHeaders() }
    );
    return response.data.secure_url;
  } catch (error) {
    console.error(
      "❌ Cloudinary Upload Error:",
      error.response?.data || error.message
    );
    throw new Error("Failed to upload CNIC image");
  }
};

router.post(
  "/signup",
  upload.fields([
    { name: "cnic", maxCount: 1 },
    { name: "OwnerDoc", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, email, password, number, role } = req.body;

      if (!role || !["user", "landlord"].includes(role)) {
        return res
          .status(400)
          .json({ error: "Invalid role. Must be 'user' or 'landlord'" });
      }

      const errorMessage = validateFields({ name, email, password, number });
      if (errorMessage) return res.status(400).json({ error: errorMessage });
      
      const userDoc = await db.collection("users").doc(email).get();
      if (userDoc.exists)
        return res.status(400).json({ error: "User already exists" });

      const hashedPassword = await bcrypt.hash(password, 10);

      let cnicUrl = "";
      let ownerDocUrl = "";
      let isActive = 0;

      if (!req.files["cnic"]) {
        return res.status(400).json({ error: "CNIC image is required" });
      }

      cnicUrl = await uploadImageToCloudinary(
        req.files["cnic"][0].buffer,
        `${email}-${uuidv4()}`
      );

      if (role === "user" && req.files["OwnerDoc"]) {
        ownerDocUrl = await uploadImageToCloudinary(
          req.files["OwnerDoc"][0].buffer,
          `${email}-ownerDoc-${uuidv4()}`
        );
      }

      if (role === "landlord") {
        isActive = 1;
      }

      await db
        .collection("users")
        .doc(email)
        .set({
          name,
          email,
          password: hashedPassword,
          number,
          role,
          cnicUrl,
          ownerDocUrl,
          isActive,
          isProfileComplete: role === "landlord",
        });

      if (role === "landlord") {
        return res
          .status(201)
          .json({ message: "Landlord registered successfully" });
      } else {
        return res.status(201).json({
          message:
            "An account registration request has been sent to the admin.",
        });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const errorMessage = validateFields({ email, password });

    if (errorMessage) return res.status(400).json({ error: errorMessage });

    const userDoc = await db.collection("users").doc(email).get();
    if (!userDoc.exists)
      return res.status(400).json({ error: "Invalid email or password" });

    const user = userDoc.data();
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ email: user.email }, JWT_SECRET, {
      expiresIn: "1h",
    });

    // Prepare user details for response
    const userInfo = {
      name: user.name,
      email: user.email,
      number: user.number,
      role: user.role,
      isProfileComplete: user.isProfileComplete || false,
      isActive: user.isActive || 0,
    };

    // Include additional info only if profile is complete
    if (user.role === "user" && user.isProfileComplete) {
      userInfo.birthDate = user.birthDate;
      userInfo.gender = user.gender;
      userInfo.sex = user.sex;
      userInfo.userImg = user.userImg || "";
      userInfo.hobbies = user.hobbies || [];
      userInfo.petPreference = user.petPreference;
      userInfo.drinkingHabit = user.drinkingHabit;
      userInfo.smokingHabit = user.smokingHabit;
      userInfo.preference = user.preference;
      userInfo.cnicUrl = user.cnicUrl || "";
      userInfo.ownerDocUrl = user.ownerDocUrl || "";
    }

    if (user.role === "landlord") {
      userInfo.cnicUrl = user.cnicUrl || "";
    }

    res.json({ token, user: userInfo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post(
  "/update-user-details",
  upload.single("userImg"),
  async (req, res) => {
    try {
      const {
        email,
        birthDate,
        gender,
        sex,
        hobbies,
        petPreference,
        drinkingHabit,
        smokingHabit,
        preference,
      } = req.body;
      const userImage = req.file;

      if (
        !email ||
        !birthDate ||
        !gender ||
        !sex ||
        !hobbies ||
        !petPreference ||
        !drinkingHabit ||
        !smokingHabit ||
        !preference
      ) {
        return res.status(400).json({ error: "All fields are required" });
      }

      const userRef = db.collection("users").doc(email);
      const userDoc = await userRef.get();

      if (!userDoc.exists)
        return res.status(404).json({ error: "User not found" });

      const user = userDoc.data();
      if (user.role !== "user")
        return res
          .status(403)
          .json({ error: "Only users can update additional details" });

      let userImgUrl = user.userImg || ""; // Keep existing image if not updated

      if (userImage) {
        userImgUrl = await uploadImageToCloudinary(
          userImage.buffer,
          `${email}-profile`
        );
      }

      await userRef.update({
        birthDate,
        gender,
        sex,
        hobbies: JSON.parse(hobbies), // Ensure hobbies are stored as an array
        petPreference,
        drinkingHabit,
        smokingHabit,
        preference,
        userImg: userImgUrl,
        isProfileComplete: true, // Update the profile completion status
      });

      res.json({ message: "User details updated successfully" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
