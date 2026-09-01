const mongoose = require("mongoose");

const connectDatabase = async () => {
    try {
        const connection = await mongoose.connect(process.env.MONGODB_URI, {
            // Disable autoIndex in production — use migrations or a one-time
            // script instead.  In development and test the default (true) is
            // kept so schemas stay in sync without a separate step.
            autoIndex: process.env.NODE_ENV !== "production",
        });

        console.log(
            `MongoDB connected: ${connection.connection.host}`
        );
    } catch (error) {
        console.error("MongoDB connection failed:");
        console.error(error.message);

        process.exit(1);
    }
};

module.exports = connectDatabase;