export const normalizeUser = (user: any) => {
    if (!user) {
        return;
    }

    // Current query IDs return split profile fields without a legacy user object.
    return {
        ...user.legacy,
        ...user.core,
        ...(user.rest_id && { id_str: user.rest_id }),
        ...(user.avatar?.image_url && { profile_image_url: user.avatar.image_url, profile_image_url_https: user.avatar.image_url }),
        ...user.profile_bio,
    };
};
