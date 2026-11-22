import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../domain/models.dart';

const maxGrowthPhotosPerRecord = 5;
const maxGrowthPhotoBytes = 20 * 1024 * 1024;

abstract interface class GrowthFileStore {
  Future<List<PreparedGrowthPhoto>> copyPhotos({
    required String familyId,
    required String childId,
    required String recordId,
    required List<String> sourcePaths,
  });
  Future<Uint8List> readPhoto(String path);
  Future<void> deletePhoto(String path);
}

/// 把系统选择器返回的临时文件复制到应用私有目录，并记录可校验摘要。
class LocalGrowthFileStore implements GrowthFileStore {
  LocalGrowthFileStore({Future<Directory> Function()? rootProvider})
    : _rootProvider =
          rootProvider ?? (() async => getApplicationSupportDirectory());

  final Future<Directory> Function() _rootProvider;

  @override
  Future<List<PreparedGrowthPhoto>> copyPhotos({
    required String familyId,
    required String childId,
    required String recordId,
    required List<String> sourcePaths,
  }) async {
    if (sourcePaths.length > maxGrowthPhotosPerRecord) {
      throw const FormatException('一条记录最多保存 5 张照片。');
    }
    final root = await _rootProvider();
    final target = Directory(
      p.join(
        root.path,
        'private-growth',
        _safeSegment(familyId),
        _safeSegment(childId),
        _safeSegment(recordId),
      ),
    );
    await target.create(recursive: true);
    final copied = <File>[];
    final prepared = <PreparedGrowthPhoto>[];
    try {
      for (final sourcePath in sourcePaths) {
        final source = File(sourcePath);
        final length = await source.length();
        if (length <= 0) throw const FormatException('选中的照片是空文件。');
        if (length > maxGrowthPhotoBytes) {
          throw const FormatException('单张照片不能超过 20MB。');
        }
        final bytes = await source.readAsBytes();
        final mime = _detectMime(bytes);
        final extension = switch (mime) {
          'image/jpeg' => '.jpg',
          'image/png' => '.png',
          _ => '.webp',
        };
        final file = File(
          p.join(target.path, '${const Uuid().v4()}$extension'),
        );
        await file.writeAsBytes(bytes, flush: true);
        copied.add(file);
        prepared.add(
          PreparedGrowthPhoto(
            localPath: file.path,
            mime: mime,
            byteSize: bytes.length,
            sha256: sha256.convert(bytes).toString(),
          ),
        );
      }
      return List.unmodifiable(prepared);
    } on Object {
      for (final file in copied) {
        try {
          await file.delete();
        } on FileSystemException {
          // 清理失败不回传临时路径，也不覆盖用户正文。
        }
      }
      rethrow;
    }
  }

  @override
  Future<Uint8List> readPhoto(String path) async {
    final root = await _rootProvider();
    final privateRoot = p.canonicalize(p.join(root.path, 'private-growth'));
    final candidate = p.canonicalize(path);
    if (!p.isWithin(privateRoot, candidate) && candidate != privateRoot) {
      throw const FileSystemException('照片路径不属于应用私有目录。');
    }
    return File(candidate).readAsBytes();
  }

  @override
  Future<void> deletePhoto(String path) async {
    final root = await _rootProvider();
    final privateRoot = p.canonicalize(p.join(root.path, 'private-growth'));
    final candidate = p.canonicalize(path);
    if (!p.isWithin(privateRoot, candidate) && candidate != privateRoot) {
      throw const FileSystemException('拒绝删除应用私有目录外的文件。');
    }
    final file = File(candidate);
    if (await file.exists()) await file.delete();
  }

  static String _safeSegment(String value) {
    final clean = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    if (clean.isEmpty || clean == '.' || clean == '..') {
      throw const FormatException('家庭范围标识无效。');
    }
    return clean;
  }

  static String _detectMime(Uint8List bytes) {
    if (bytes.length >= 3 &&
        bytes[0] == 0xff &&
        bytes[1] == 0xd8 &&
        bytes[2] == 0xff) {
      return 'image/jpeg';
    }
    if (bytes.length >= 8 &&
        bytes[0] == 0x89 &&
        bytes[1] == 0x50 &&
        bytes[2] == 0x4e &&
        bytes[3] == 0x47 &&
        bytes[4] == 0x0d &&
        bytes[5] == 0x0a &&
        bytes[6] == 0x1a &&
        bytes[7] == 0x0a) {
      return 'image/png';
    }
    if (bytes.length >= 12 &&
        ascii.decode(bytes.sublist(0, 4), allowInvalid: true) == 'RIFF' &&
        ascii.decode(bytes.sublist(8, 12), allowInvalid: true) == 'WEBP') {
      return 'image/webp';
    }
    throw const FormatException('只支持 JPEG、PNG 或 WebP 照片。');
  }
}

abstract interface class ExportFileSaver {
  /// 返回用户实际选择的目标位置描述；取消时返回 null。
  Future<String?> saveZip(Uint8List bytes, String suggestedName);

  /// 保存不含任何登录令牌的本机待同步草稿副本。
  Future<String?> saveJson(Uint8List bytes, String suggestedName);
}

/// Android 使用系统文件选择器写入用户选定的位置，不申请全盘存储权限。
class AndroidExportFileSaver implements ExportFileSaver {
  const AndroidExportFileSaver();

  static const _channel = MethodChannel('app.babyplan/files');

  @override
  Future<String?> saveZip(Uint8List bytes, String suggestedName) async {
    return _saveFile(
      bytes,
      suggestedName,
      method: 'saveZip',
      mime: 'application/zip',
    );
  }

  @override
  Future<String?> saveJson(Uint8List bytes, String suggestedName) => _saveFile(
    bytes,
    suggestedName,
    method: 'saveFile',
    mime: 'application/json',
  );

  Future<String?> _saveFile(
    Uint8List bytes,
    String suggestedName, {
    required String method,
    required String mime,
  }) async {
    final temporary = await getTemporaryDirectory();
    final extension = p.extension(suggestedName);
    final file = File(
      p.join(temporary.path, 'babyplan-export-${const Uuid().v4()}$extension'),
    );
    await file.writeAsBytes(bytes, flush: true);
    try {
      return await _channel.invokeMethod<String>(method, {
        'sourcePath': file.path,
        'fileName': suggestedName,
        'mimeType': mime,
      });
    } on PlatformException catch (error) {
      throw StateError(error.message ?? '没有完成文件保存。');
    } finally {
      try {
        if (await file.exists()) await file.delete();
      } on FileSystemException {
        // 系统缓存清理不覆盖已经完成的用户选择。
      }
    }
  }
}
